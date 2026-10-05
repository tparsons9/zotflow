import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_VAULT = join(homedir(), "vaults", "tanners-vault");
export const FILES = [
    "main.js",
    "manifest.json",
    "styles.css",
    "reader.js.LICENSE.txt",
];
const REQUIRED = FILES.slice(0, 3);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const git = (root, args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function sourceInfo(root = ROOT) {
    if (git(root, ["branch", "--show-current"]) !== "personal") {
        throw new Error(
            "Install from the personal branch, after committing completed work.",
        );
    }
    if (git(root, ["status", "--porcelain", "--untracked-files=normal"])) {
        throw new Error(
            "Parent and reader worktrees must be clean before installation.",
        );
    }
    if (
        git(root, ["submodule", "status", "--recursive"])
            .split("\n")
            .some((line) => /^[+\-U]/u.test(line))
    ) {
        throw new Error(
            "Initialize all submodules at their committed pins before installation.",
        );
    }
    if (
        git(root, [
            "submodule",
            "foreach",
            "--quiet",
            "--recursive",
            "git status --porcelain --untracked-files=normal",
        ])
    ) {
        throw new Error(
            "All nested submodule worktrees must be clean before installation.",
        );
    }
    const pin = git(root, ["ls-tree", "HEAD", "reader/reader"]).match(
        /^160000 commit ([a-f0-9]{40})\t/u,
    )?.[1];
    const readerCommit = git(join(root, "reader/reader"), [
        "rev-parse",
        "HEAD",
    ]);
    if (!pin || pin !== readerCommit)
        throw new Error(
            "Reader checkout does not match the committed submodule pin.",
        );
    const versions = [
        ...readFileSync(join(root, "src/db/db.ts"), "utf8").matchAll(
            /this\.version\(\s*(\d+)\s*\)/gu,
        ),
    ].map((match) => Number(match[1]));
    if (!versions.length)
        throw new Error(
            "Cannot determine the declared database schema version.",
        );
    if (json(join(root, "manifest.json")).id !== "zotflow")
        throw new Error("Expected plugin ID zotflow.");
    return {
        commit: git(root, ["rev-parse", "HEAD"]),
        readerCommit,
        databaseSchemaVersion: Math.max(...versions),
        upstream: json(join(root, ".github/upstream-state.json")),
    };
}

function assertRegular(path, directory = false) {
    let stat;
    try {
        stat = lstatSync(path);
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
    if (
        stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile())
    ) {
        throw new Error(
            `Expected a regular ${directory ? "directory" : "file"}: ${path}`,
        );
    }
    return true;
}

export function destination(vault = DEFAULT_VAULT, root = ROOT) {
    const expanded =
        vault === "~"
            ? homedir()
            : vault.startsWith("~/")
              ? join(homedir(), vault.slice(2))
              : vault;
    const absolute = resolve(expanded);
    if (
        !assertRegular(absolute, true) ||
        !assertRegular(join(absolute, ".obsidian"), true)
    ) {
        throw new Error(`Expected an existing Obsidian vault: ${absolute}`);
    }
    const canonical = realpathSync(absolute);
    const pluginDir = join(canonical, ".obsidian/plugins/zotflow");
    for (const path of [join(canonical, ".obsidian/plugins"), pluginDir])
        assertRegular(path, true);
    for (const name of FILES) assertRegular(join(pluginDir, name));
    const key = hash(canonical).slice(0, 20);
    const local = join(root, ".personal");
    const receipts = join(local, "installations");
    const backups = join(local, "backups", key);
    for (const path of [local, receipts, join(local, "backups"), backups])
        assertRegular(path, true);
    const receiptPath = join(receipts, `${key}.json`);
    assertRegular(receiptPath);
    return {
        root: resolve(root),
        vault: canonical,
        pluginDir,
        receiptPath,
        backups,
    };
}

function readFiles(directory) {
    return Object.fromEntries(
        FILES.map((name) => {
            const path = join(directory, name);
            return [name, assertRegular(path) ? readFileSync(path) : null];
        }),
    );
}

function hashes(files) {
    return Object.fromEntries(
        FILES.map((name) => [
            name,
            files[name] === null ? null : hash(files[name]),
        ]),
    );
}

function readReceipt(dest) {
    if (!existsSync(dest.receiptPath)) return null;
    const receipt = json(dest.receiptPath);
    if (receipt.vault !== dest.vault || receipt.format !== 1)
        throw new Error("Invalid installation receipt for this vault.");
    return receipt;
}

export function installationStatus({
    root = ROOT,
    vault = DEFAULT_VAULT,
} = {}) {
    const dest = destination(vault, root);
    const receipt = readReceipt(dest);
    const actual = hashes(readFiles(dest.pluginDir));
    const changed = receipt
        ? FILES.filter((name) => actual[name] !== receipt.files[name])
        : FILES;
    return {
        vault: dest.vault,
        receipt,
        verified: Boolean(receipt) && changed.length === 0,
        changed,
    };
}

function atomicJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, `${JSON.stringify(value, null, 4)}\n`, {
            flag: "wx",
        });
        renameSync(temp, path);
    } finally {
        rmSync(temp, { force: true });
    }
}

// Only managed artifacts are replaced; settings and annotation files never enter here.
export function replaceArtifacts(dest, files, receipt, options = {}) {
    destination(dest.vault, dest.root);
    mkdirSync(dirname(dest.receiptPath), { recursive: true });
    const lock = `${dest.receiptPath}.lock`;
    try {
        mkdirSync(lock);
    } catch (error) {
        if (error.code === "EEXIST")
            throw new Error(
                "Another installation holds this vault's lock. If its process stopped, remove the stale receipt .lock directory before retrying.",
            );
        throw error;
    }
    try {
        return replaceUnlocked(dest, files, receipt, options);
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}

function replaceUnlocked(dest, files, receipt, { replace = renameSync } = {}) {
    const oldFiles = readFiles(dest.pluginDir);
    const oldReceipt = readReceipt(dest);
    const oldHashes = hashes(oldFiles);
    const trusted =
        oldReceipt &&
        FILES.every((name) => oldHashes[name] === oldReceipt.files[name]);
    const backupId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const backupDir = join(dest.backups, backupId);
    mkdirSync(backupDir, { recursive: true });
    for (const name of FILES) {
        if (oldFiles[name] !== null)
            writeFileSync(join(backupDir, name), oldFiles[name], {
                flag: "wx",
            });
    }
    atomicJson(join(backupDir, "backup.json"), {
        format: 1,
        vault: dest.vault,
        files: hashes(oldFiles),
        previousReceipt: trusted ? oldReceipt : null,
    });
    mkdirSync(dest.pluginDir, { recursive: true });
    const stage = join(dest.pluginDir, `.zotflow-install-${randomUUID()}`);
    mkdirSync(stage);
    const touched = [];
    try {
        for (const name of FILES) {
            if (files[name] !== null)
                writeFileSync(join(stage, name), files[name], { flag: "wx" });
        }
        for (const name of FILES) {
            touched.push(name);
            if (files[name] !== null) {
                replace(join(stage, name), join(dest.pluginDir, name));
            } else if (oldFiles[name] !== null) {
                unlinkSync(join(dest.pluginDir, name));
            }
        }
        atomicJson(dest.receiptPath, { ...receipt, backupId });
    } catch (error) {
        // Use the real rename for recovery, independent of the failed replacement.
        for (const name of touched.reverse()) {
            const target = join(dest.pluginDir, name);
            if (oldFiles[name] !== null) {
                const temp = join(stage, `restore-${name}`);
                writeFileSync(temp, oldFiles[name]);
                renameSync(temp, target);
            } else rmSync(target, { force: true });
        }
        throw new Error(
            `Installation failed; restored previous artifacts. Backup: ${backupId}`,
            { cause: error },
        );
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
    return { ...receipt, backupId };
}

function runChecks(root) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    for (const [cwd, args] of [
        [root, ["test"]],
        [root, ["run", "test:personal"]],
        [join(root, "reader/reader"), ["test"]],
        [root, ["run", "build:ci"]],
    ]) {
        const result = spawnSync(npm, args, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        if (result.error || result.status !== 0)
            throw new Error(`Checks/build failed: npm ${args.join(" ")}`, {
                cause: result.error,
            });
    }
}

export function installPersonal({
    root = ROOT,
    vault = DEFAULT_VAULT,
    dryRun = false,
    check = runChecks,
} = {}) {
    const dest = destination(vault, root);
    const source = sourceInfo(root);
    if (dryRun)
        return {
            dryRun: true,
            vault: dest.vault,
            source,
            steps: [
                "npm test",
                "npm run test:personal",
                "reader npm test",
                "npm run build:ci",
                "back up and copy managed artifacts",
                "record receipt",
            ],
        };
    check(root);
    if (JSON.stringify(sourceInfo(root)) !== JSON.stringify(source))
        throw new Error(
            "Source changed during validation; vault was not modified.",
        );
    destination(vault, root);
    const files = readFiles(root);
    for (const name of REQUIRED)
        if (!files[name]?.length)
            throw new Error(`Missing or empty build artifact: ${name}`);
    const receipt = {
        format: 1,
        vault: dest.vault,
        installedAt: new Date().toISOString(),
        ...source,
        files: hashes(files),
    };
    return replaceArtifacts(dest, files, receipt);
}

export function rollbackPersonal({
    root = ROOT,
    vault = DEFAULT_VAULT,
    backupId,
    dryRun = false,
} = {}) {
    if (!backupId || !/^[a-zA-Z0-9.-]+$/u.test(backupId))
        throw new Error("Supply --backup <id> from an installation receipt.");
    const dest = destination(vault, root);
    const current = installationStatus({ root, vault });
    if (!current.verified)
        throw new Error(
            "Current installed artifacts must match their receipt before rollback.",
        );
    const backupDir = join(dest.backups, backupId);
    assertRegular(backupDir, true);
    assertRegular(join(backupDir, "backup.json"));
    const backup = json(join(backupDir, "backup.json"));
    const previous = backup.previousReceipt;
    if (
        backup.vault !== dest.vault ||
        !previous ||
        previous.vault !== dest.vault ||
        previous.format !== 1 ||
        !Number.isSafeInteger(previous.databaseSchemaVersion) ||
        previous.databaseSchemaVersion !== current.receipt.databaseSchemaVersion
    ) {
        throw new Error(
            "Cannot roll back across unknown or different database schemas. Artifact backups do not reverse migrations.",
        );
    }
    const files = readFiles(backupDir);
    const actual = hashes(files);
    if (
        FILES.some(
            (name) =>
                actual[name] !== backup.files[name] ||
                actual[name] !== previous.files[name],
        )
    )
        throw new Error("Backup artifacts failed hash verification.");
    if (dryRun)
        return {
            dryRun: true,
            vault: dest.vault,
            restore: previous.commit,
            backupId,
        };
    return replaceArtifacts(dest, files, {
        ...previous,
        restoredAt: new Date().toISOString(),
    });
}

function main(args) {
    const command = args.shift();
    let vault = DEFAULT_VAULT;
    let backupId;
    let dryRun = false;
    while (args.length) {
        const option = args.shift();
        if (option === "--dry-run") dryRun = true;
        else if (option === "--vault" && args[0] && !args[0].startsWith("--"))
            vault = args.shift();
        else if (option === "--backup" && args[0] && !args[0].startsWith("--"))
            backupId = args.shift();
        else throw new Error(`Unknown or incomplete option: ${option}`);
    }
    let result;
    if (command === "install") result = installPersonal({ vault, dryRun });
    else if (command === "status") {
        result = installationStatus({ vault });
        if (!result.verified) process.exitCode = 1;
    } else if (command === "rollback")
        result = rollbackPersonal({ vault, backupId, dryRun });
    else
        throw new Error(
            "Usage: personal-install.mjs install|status|rollback [--vault path] [--dry-run] [--backup id]",
        );
    console.log(JSON.stringify(result, null, 4));
    if (command !== "status" && !dryRun)
        console.log(
            "Enable ZotFlow again in Obsidian. File restoration does not restore settings or IndexedDB.",
        );
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
