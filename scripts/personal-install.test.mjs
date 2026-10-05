import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    destination,
    FILES,
    installPersonal,
    installationStatus,
    replaceArtifacts,
    rollbackPersonal,
    sourceInfo,
} from "./personal-install.mjs";

function fixture(t) {
    const base = mkdtempSync(join(tmpdir(), "zotflow-personal-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, "repo");
    const reader = join(base, "reader");
    const vault = join(base, "vault with spaces");
    const plugin = join(vault, ".obsidian/plugins/zotflow");
    const git = (cwd, args) =>
        execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    for (const dir of [root, reader]) {
        mkdirSync(dir);
        git(dir, ["init", "-b", "personal"]);
        git(dir, ["config", "user.name", "Test"]);
        git(dir, ["config", "user.email", "test@example.invalid"]);
    }
    writeFileSync(join(reader, "source.js"), "reader\n");
    git(reader, ["add", "."]);
    git(reader, ["commit", "-m", "reader"]);
    git(root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        reader,
        "reader/reader",
    ]);
    mkdirSync(join(root, "src/db"), { recursive: true });
    mkdirSync(join(root, ".github"));
    writeFileSync(
        join(root, "src/db/db.ts"),
        "this.version(6); this.version(7);\n",
    );
    writeFileSync(
        join(root, ".github/upstream-state.json"),
        JSON.stringify({ fixture: true }),
    );
    writeFileSync(
        join(root, ".gitignore"),
        "main.js\nreader.js.LICENSE.txt\n.personal/\n",
    );
    writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({ id: "zotflow", version: "1.6.6" }),
    );
    writeFileSync(join(root, "styles.css"), "new styles\n");
    writeFileSync(join(root, "main.js"), "new plugin\n");
    writeFileSync(join(root, "reader.js.LICENSE.txt"), "reader notice\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "parent"]);
    mkdirSync(plugin, { recursive: true });
    for (const name of FILES)
        writeFileSync(join(plugin, name), `old ${name}\n`);
    writeFileSync(join(plugin, "data.json"), "private settings\n");
    writeFileSync(join(vault, "paper.zf.json"), "annotations\n");
    mkdirSync(join(plugin, "enhancement-pack"));
    writeFileSync(join(plugin, "enhancement-pack/keep"), "pack\n");
    const options = { root, vault, check: () => {} };
    return { root, vault, plugin, git, options };
}

test("installs a pinned clean build and detects same-version artifact replacements", (t) => {
    const f = fixture(t);
    const receipt = installPersonal(f.options);
    assert.equal(receipt.databaseSchemaVersion, 7);
    assert.equal(
        receipt.readerCommit,
        f.git(join(f.root, "reader/reader"), ["rev-parse", "HEAD"]),
    );
    assert.equal(
        readFileSync(join(f.plugin, "main.js"), "utf8"),
        "new plugin\n",
    );
    assert.equal(
        readFileSync(join(f.plugin, "data.json"), "utf8"),
        "private settings\n",
    );
    assert.equal(
        readFileSync(join(f.vault, "paper.zf.json"), "utf8"),
        "annotations\n",
    );
    assert.equal(
        readFileSync(join(f.plugin, "enhancement-pack/keep"), "utf8"),
        "pack\n",
    );
    assert.equal(installationStatus(f.options).verified, true);
    writeFileSync(join(f.plugin, "main.js"), "community replacement\n");
    assert.deepEqual(installationStatus(f.options).changed, ["main.js"]);
});

test("dry run neither builds nor creates local state", (t) => {
    const f = fixture(t);
    const result = installPersonal({
        ...f.options,
        dryRun: true,
        check: () => assert.fail("dry run built"),
    });
    assert.equal(result.dryRun, true);
    assert.equal(existsSync(join(f.root, ".personal")), false);
    assert.equal(
        readFileSync(join(f.plugin, "main.js"), "utf8"),
        "old main.js\n",
    );
});

test("failed tests/builds and source mutations leave the vault unchanged", (t) => {
    const f = fixture(t);
    assert.throws(
        () =>
            installPersonal({
                ...f.options,
                check: () => {
                    throw new Error("build failed");
                },
            }),
        /build failed/u,
    );
    assert.equal(existsSync(join(f.root, ".personal")), false);
    assert.throws(
        () =>
            installPersonal({
                ...f.options,
                check: () =>
                    writeFileSync(
                        join(f.root, "styles.css"),
                        "changed during build",
                    ),
            }),
        /clean/u,
    );
    assert.equal(
        readFileSync(join(f.plugin, "main.js"), "utf8"),
        "old main.js\n",
    );
});

test("rejects wrong branches, dirty readers, untracked source and mismatched pins", (t) => {
    const f = fixture(t);
    f.git(f.root, ["switch", "-c", "feature"]);
    assert.throws(() => sourceInfo(f.root), /personal branch/u);
    f.git(f.root, ["switch", "personal"]);
    writeFileSync(join(f.root, "untracked.txt"), "dirty\n");
    assert.throws(() => sourceInfo(f.root), /clean/u);
    rmSync(join(f.root, "untracked.txt"));
    const reader = join(f.root, "reader/reader");
    writeFileSync(join(reader, "source.js"), "dirty reader\n");
    assert.throws(() => sourceInfo(f.root), /clean/u);
    f.git(reader, ["config", "user.name", "Test"]);
    f.git(reader, ["config", "user.email", "test@example.invalid"]);
    f.git(reader, ["add", "."]);
    f.git(reader, ["commit", "-m", "unpinned reader"]);
    assert.throws(() => sourceInfo(f.root), /clean|pins/u);
});

test("rejects missing vaults and symlinked directories/artifacts", (t) => {
    const f = fixture(t);
    assert.throws(
        () => destination(join(f.vault, "missing"), f.root),
        /existing Obsidian vault/u,
    );
    rmSync(join(f.plugin, "main.js"));
    symlinkSync(join(f.root, "main.js"), join(f.plugin, "main.js"));
    assert.throws(() => installPersonal(f.options), /regular file/u);
    rmSync(join(f.plugin, "main.js"));
    rmSync(f.plugin, { recursive: true });
    symlinkSync(f.root, f.plugin);
    assert.throws(() => installPersonal(f.options), /regular directory/u);
});

test("supports a missing plugin directory and rejects missing build artifacts", (t) => {
    const f = fixture(t);
    rmSync(f.plugin, { recursive: true });
    rmSync(join(f.root, "main.js"));
    assert.throws(() => installPersonal(f.options), /Missing or empty/u);
    assert.equal(existsSync(f.plugin), false);
    writeFileSync(join(f.root, "main.js"), "new plugin\n");
    installPersonal(f.options);
    assert.equal(installationStatus(f.options).verified, true);
});

test("partial replacement failure restores the complete previous artifact set", (t) => {
    const f = fixture(t);
    const dest = destination(f.vault, f.root);
    const files = Object.fromEntries(
        FILES.map((name) => [name, readFileSync(join(f.root, name))]),
    );
    let count = 0;
    assert.throws(
        () =>
            replaceArtifacts(
                dest,
                files,
                {},
                {
                    replace: (from, to) => {
                        renameSync(from, to);
                        if (++count === 2)
                            throw new Error("disk failure after rename");
                    },
                },
            ),
        /restored previous artifacts/u,
    );
    for (const name of FILES)
        assert.equal(
            readFileSync(join(f.plugin, name), "utf8"),
            `old ${name}\n`,
        );
    assert.equal(existsSync(dest.receiptPath), false);
});

test("rolls back verified same-schema builds, preserving settings and a recovery backup", (t) => {
    const f = fixture(t);
    installPersonal(f.options);
    writeFileSync(join(f.root, "main.js"), "second build\n");
    const second = installPersonal(f.options);
    const preview = rollbackPersonal({
        ...f.options,
        backupId: second.backupId,
        dryRun: true,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(
        readFileSync(join(f.plugin, "main.js"), "utf8"),
        "second build\n",
    );
    rollbackPersonal({ ...f.options, backupId: second.backupId });
    assert.equal(
        readFileSync(join(f.plugin, "main.js"), "utf8"),
        "new plugin\n",
    );
    assert.equal(
        readFileSync(join(f.plugin, "data.json"), "utf8"),
        "private settings\n",
    );
    assert.equal(installationStatus(f.options).verified, true);
});

test("blocks rollback for unknown/different schema, altered backups, drift and path traversal", (t) => {
    const f = fixture(t);
    const first = installPersonal(f.options);
    assert.throws(
        () => rollbackPersonal({ ...f.options, backupId: first.backupId }),
        /unknown or different/u,
    );
    writeFileSync(join(f.root, "src/db/db.ts"), "this.version(8);\n");
    f.git(f.root, ["add", "."]);
    f.git(f.root, ["commit", "-m", "schema change"]);
    const second = installPersonal(f.options);
    assert.throws(
        () => rollbackPersonal({ ...f.options, backupId: second.backupId }),
        /unknown or different/u,
    );
    const third = installPersonal(f.options);
    const dest = destination(f.vault, f.root);
    writeFileSync(
        join(dest.backups, third.backupId, "main.js"),
        "tampered backup\n",
    );
    assert.throws(
        () => rollbackPersonal({ ...f.options, backupId: third.backupId }),
        /hash verification/u,
    );
    writeFileSync(join(f.plugin, "main.js"), "drift\n");
    assert.throws(
        () => rollbackPersonal({ ...f.options, backupId: third.backupId }),
        /match their receipt/u,
    );
    assert.throws(
        () => rollbackPersonal({ ...f.options, backupId: "../../escape" }),
        /Supply --backup/u,
    );
});
