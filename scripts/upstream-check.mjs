import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORK = "tparsons9/zotflow";
export const SOURCES = {
    zotflow: "duanxianpi/zotflow",
    reader: "duanxianpi/obsidian-zotero-reader",
};
const LABEL = "upstream-update";
const START = "<!-- zotflow-upstream-start -->";
const END = "<!-- zotflow-upstream-end -->";
const SHA = /^[a-f0-9]{40}$/u;
const stable = /^\d+\.\d+\.\d+$/u;

export class GitHubClient {
    constructor({ token, fetcher = fetch } = {}) {
        this.token = token;
        this.fetcher = fetcher;
    }

    async request(method, route, body) {
        if (!route.startsWith("/repos/"))
            throw new Error("Only repository API routes are allowed.");
        if (
            method !== "GET" &&
            !/^\/repos\/tparsons9\/zotflow\/(?:issues(?:\/\d+(?:\/comments)?)?|labels)$/u.test(
                route,
            )
        ) {
            throw new Error(
                `Refusing writes outside ${FORK}'s issues and labels.`,
            );
        }
        const response = await this.fetcher(`https://api.github.com${route}`, {
            method,
            headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                ...(this.token
                    ? { Authorization: `Bearer ${this.token}` }
                    : {}),
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
            const error = new Error(
                `GitHub ${method} ${route.split("?")[0]} failed (${response.status}).`,
            );
            error.status = response.status;
            throw error;
        }
        return response.status === 204 ? null : response.json();
    }

    async pages(route) {
        const results = [];
        for (let page = 1; ; page++) {
            const batch = await this.request(
                "GET",
                `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
            );
            if (!Array.isArray(batch))
                throw new Error("Expected a paginated GitHub list.");
            results.push(...batch);
            if (batch.length < 100) return results;
        }
    }
}

export function validateState(state) {
    for (const source of Object.keys(SOURCES)) {
        if (
            state[source]?.repository !== SOURCES[source] ||
            !SHA.test(state[source]?.commit ?? "")
        ) {
            throw new Error(`Invalid ${source} upstream provenance.`);
        }
    }
    if (
        !stable.test(state.zotflow.tag) ||
        !SHA.test(state.zotflow.developmentBase ?? "") ||
        state.reader.tracking !== "zotflow-release-pin"
    ) {
        throw new Error(
            "Expected stable ZotFlow provenance and release-pinned reader tracking.",
        );
    }
}

function marker(issue) {
    const match = issue.body?.match(/<!-- zotflow-upstream:(.*?) -->/u);
    if (!match) return null;
    try {
        const value = JSON.parse(match[1]);
        return Object.hasOwn(SOURCES, value.source) &&
            Array.isArray(value.targets)
            ? value
            : null;
    } catch {
        return null;
    }
}

function managedBody(target, targets) {
    const meta = { source: target.source, targets };
    const lines = [
        START,
        `<!-- zotflow-upstream:${JSON.stringify(meta)} -->`,
        "@tparsons9 — an upstream stable ZotFlow release is available.",
        "",
        `Adopted upstream commit: [${target.base.slice(0, 7)}](https://github.com/${target.repository}/commit/${target.base})`,
        `Available: [${target.tag}](${target.url})`,
        `[Compare changes](https://github.com/${target.repository}/compare/${target.base}...${target.commit})`,
        `Comparison: **${target.comparison}**. Review divergent histories before merging.`,
        "",
    ];
    if (target.readerPin)
        lines.push(
            `This release pins reader commit [${target.readerPin.slice(0, 7)}](https://github.com/${SOURCES.reader}/commit/${target.readerPin}).`,
            `[Compare reader changes](https://github.com/${SOURCES.reader}/compare/${target.readerBase}...${target.readerPin})`,
            "",
        );
    lines.push(
        "Review on a branch based on personal. Inspect this release's pinned reader changes and merge the changes you need into your personal reader first. Push its reviewed commit to your reader fork, then merge the exact ZotFlow release tag and commit the matching custom reader pin. Preserve custom annotation features and the fork submodule URL.",
        "",
        "Run checks, update .github/upstream-state.json only for upstream commits actually integrated, and merge the reviewed result into personal. Close readers and disable ZotFlow before running npm run install:personal; enable it again afterward.",
        "",
        "Closing this issue acknowledges its recorded targets; it does not change adopted provenance or install anything.",
        END,
    );
    return lines.join("\n");
}

async function ensureLabel(client) {
    try {
        await client.request("GET", `/repos/${FORK}/labels/${LABEL}`);
    } catch (error) {
        if (error.status !== 404) throw error;
        await client.request("POST", `/repos/${FORK}/labels`, {
            name: LABEL,
            color: "1d76db",
            description: "Upstream changes available for personal review",
        });
    }
}

export async function discoverTargets(client, state) {
    validateState(state);
    // Published stable releases are the only alert trigger; branch heads are never queried.
    const release = await client.request(
        "GET",
        `/repos/${SOURCES.zotflow}/releases/latest`,
    );
    if (release.draft || release.prerelease || !stable.test(release.tag_name))
        throw new Error(
            "Latest ZotFlow release is not a stable numeric release.",
        );
    const zotflowCommit = await client.request(
        "GET",
        `/repos/${SOURCES.zotflow}/commits/${encodeURIComponent(release.tag_name)}`,
    );
    if (!SHA.test(zotflowCommit.sha))
        throw new Error("Invalid upstream commit response.");
    if (
        zotflowCommit.sha === state.zotflow.commit &&
        release.tag_name === state.zotflow.tag
    )
        return [];
    const comparison = await client.request(
        "GET",
        `/repos/${SOURCES.zotflow}/compare/${state.zotflow.commit}...${zotflowCommit.sha}`,
    );
    if (
        !["ahead", "behind", "identical", "diverged"].includes(
            comparison.status,
        )
    )
        throw new Error("Unknown upstream comparison status.");
    if (comparison.status === "behind") return [];
    // Read the reader pin from the immutable release tree before any issue writes.
    const tree = await client.request(
        "GET",
        `/repos/${SOURCES.zotflow}/git/trees/${zotflowCommit.sha}?recursive=1`,
    );
    const pin = tree.tree?.find(
        (entry) => entry.path === "reader/reader" && entry.mode === "160000",
    )?.sha;
    if (tree.truncated || !SHA.test(pin ?? ""))
        throw new Error("Cannot read release reader pin.");
    return [
        {
            source: "zotflow",
            repository: SOURCES.zotflow,
            tag: release.tag_name,
            commit: zotflowCommit.sha,
            base: state.zotflow.commit,
            key: `${release.tag_name}:${zotflowCommit.sha}`,
            url: `https://github.com/${SOURCES.zotflow}/releases/tag/${release.tag_name}`,
            comparison: comparison.status,
            readerPin: pin,
            readerBase: state.reader.commit,
        },
    ];
}

export async function checkUpstream({
    client,
    state,
    dryRun = false,
    repository = process.env.GITHUB_REPOSITORY ?? FORK,
} = {}) {
    if (repository !== FORK)
        throw new Error(`This watcher only runs in ${FORK}.`);
    const targets = await discoverTargets(client, state);
    const issues = await client.pages(
        `/repos/${FORK}/issues?state=all&labels=${LABEL}`,
    );
    const actions = [];
    let labelReady = false;
    for (const target of targets) {
        const tracked = issues.filter(
            (issue) =>
                !issue.pull_request && marker(issue)?.source === target.source,
        );
        if (
            tracked.some((issue) => marker(issue).targets.includes(target.key))
        ) {
            actions.push({
                source: target.source,
                action: "already-notified",
                target: target.key,
            });
            continue;
        }
        const open = tracked.filter((issue) => issue.state === "open");
        if (open.length > 1)
            throw new Error(
                `Multiple open ${target.source} update issues; reconcile them manually.`,
            );
        const existing = open[0];
        const recorded = [
            ...(existing ? marker(existing).targets : []),
            target.key,
        ];
        const title = `Upstream ZotFlow ${target.tag} available`;
        const block = managedBody(target, recorded);
        let body = block;
        if (existing) {
            if (!existing.body.includes(START) || !existing.body.includes(END))
                throw new Error(
                    "Update issue is missing its managed section; refusing to replace human notes.",
                );
            const begin = existing.body.indexOf(START);
            const end = existing.body.indexOf(END) + END.length;
            body =
                existing.body.slice(0, begin) +
                block +
                existing.body.slice(end);
        }
        actions.push({
            source: target.source,
            action: existing ? "update-issue" : "create-issue",
            target: target.key,
            title,
            ...(existing ? { issue: existing.number } : {}),
        });
        if (dryRun) continue;
        if (!labelReady) {
            await ensureLabel(client);
            labelReady = true;
        }
        if (existing) {
            const comments = await client.pages(
                `/repos/${FORK}/issues/${existing.number}/comments`,
            );
            const notification = `<!-- zotflow-notified:${target.key} -->`;
            // Notify first. If the body patch fails, a retry finds this comment instead of sending it twice.
            if (
                !comments.some((comment) =>
                    comment.body?.includes(notification),
                )
            ) {
                await client.request(
                    "POST",
                    `/repos/${FORK}/issues/${existing.number}/comments`,
                    {
                        body: `${notification}\n@tparsons9 — another upstream stable release is available: [${target.tag}](${target.url}). Review the updated target in this issue.`,
                    },
                );
            }
            await client.request(
                "PATCH",
                `/repos/${FORK}/issues/${existing.number}`,
                { title, body },
            );
        } else {
            const issue = await client.request(
                "POST",
                `/repos/${FORK}/issues`,
                { title, body, labels: [LABEL], assignees: ["tparsons9"] },
            );
            actions.at(-1).issue = issue.number;
        }
    }
    return { repository: FORK, dryRun, actions };
}

async function main(args) {
    if (args.some((arg) => arg !== "--dry-run"))
        throw new Error("Usage: upstream-check.mjs [--dry-run]");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const state = JSON.parse(
        readFileSync(join(root, ".github/upstream-state.json"), "utf8"),
    );
    const token =
        process.env.GH_TOKEN ??
        process.env.GITHUB_TOKEN ??
        execFileSync("gh", ["auth", "token"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    const result = await checkUpstream({
        client: new GitHubClient({ token }),
        state,
        dryRun: args.includes("--dry-run"),
    });
    console.log(JSON.stringify(result, null, 4));
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
