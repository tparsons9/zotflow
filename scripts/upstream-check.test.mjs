import assert from "node:assert/strict";
import test from "node:test";
import {
    checkUpstream,
    FORK,
    GitHubClient,
    SOURCES,
} from "./upstream-check.mjs";

const oldParent = "a".repeat(40);
const newParent = "b".repeat(40);
const oldReader = "c".repeat(40);
const newReader = "d".repeat(40);
const state = {
    zotflow: {
        repository: SOURCES.zotflow,
        tag: "1.6.6",
        commit: oldParent,
        developmentBase: oldParent,
    },
    reader: {
        repository: SOURCES.reader,
        tracking: "zotflow-release-pin",
        commit: oldReader,
    },
};

function fake({
    parent = oldParent,
    reader = oldReader,
    parentHead = oldParent,
    readerPin = newReader,
    truncated = false,
    pinMode = "160000",
    tag = "1.6.6",
    draft = false,
    prerelease = false,
    comparison = "ahead",
} = {}) {
    const issues = [];
    const comments = new Map();
    const calls = [];
    let fail;
    let label = false;
    const client = new GitHubClient({
        token: "test-token",
        fetcher: async (url, options) => {
            const parsed = new URL(url);
            const route = parsed.pathname;
            const method = options.method;
            const body = options.body ? JSON.parse(options.body) : null;
            calls.push({ method, route, body });
            if (fail?.(method, route)) return { ok: false, status: 503 };
            let data;
            if (method === "GET" && route.endsWith("/releases/latest"))
                data = { tag_name: tag, draft, prerelease };
            else if (
                method === "GET" &&
                route === `/repos/${SOURCES.zotflow}/commits/master`
            )
                data = { sha: parentHead };
            else if (
                method === "GET" &&
                route.startsWith(`/repos/${SOURCES.zotflow}/commits/`)
            )
                data = { sha: parent };
            else if (
                method === "GET" &&
                route === `/repos/${SOURCES.reader}/commits/master`
            )
                data = { sha: reader };
            else if (method === "GET" && route.includes("/compare/"))
                data = { status: comparison };
            else if (method === "GET" && route.includes("/git/trees/"))
                data = {
                    truncated,
                    tree: [
                        {
                            path: "reader/reader",
                            mode: pinMode,
                            sha: readerPin,
                        },
                    ],
                };
            else if (method === "GET" && route === `/repos/${FORK}/issues`)
                data = issues;
            else if (
                method === "GET" &&
                route === `/repos/${FORK}/labels/upstream-update`
            ) {
                if (!label) return { ok: false, status: 404 };
                data = { name: "upstream-update" };
            } else if (method === "POST" && route === `/repos/${FORK}/labels`) {
                label = true;
                data = body;
            } else if (route.match(/\/issues\/\d+\/comments$/u)) {
                const number = Number(route.split("/").at(-2));
                const list = comments.get(number) ?? [];
                if (method === "POST") {
                    list.push(body);
                    comments.set(number, list);
                    data = body;
                } else data = list;
            } else if (method === "POST" && route === `/repos/${FORK}/issues`) {
                data = { ...body, number: issues.length + 1, state: "open" };
                issues.push(data);
            } else if (method === "PATCH" && route.match(/\/issues\/\d+$/u)) {
                data = issues.find(
                    (issue) => issue.number === Number(route.split("/").at(-1)),
                );
                Object.assign(data, body);
            } else assert.fail(`Unexpected GitHub request ${method} ${route}`);
            return {
                ok: true,
                status: 200,
                json: async () => structuredClone(data),
            };
        },
    });
    return {
        client,
        issues,
        comments,
        calls,
        setFailure: (value) => {
            fail = value;
        },
    };
}

test("unchanged upstream makes no writes", async () => {
    const f = fake();
    const result = await checkUpstream({ client: f.client, state });
    assert.deepEqual(result.actions, []);
    assert.equal(f.calls.filter((call) => call.method !== "GET").length, 0);
});

test("a new stable release creates one assigned issue with its reader pin only in the fork", async () => {
    const f = fake({ parent: newParent, reader: newReader, tag: "1.7.0" });
    const result = await checkUpstream({ client: f.client, state });
    assert.deepEqual(
        result.actions.map((action) => action.action),
        ["create-issue"],
    );
    assert.equal(f.issues.length, 1);
    assert.match(f.issues[0].body, /pins reader commit/u);
    assert.ok(
        f.issues[0].body.includes(
            `https://github.com/${SOURCES.reader}/compare/${oldReader}...${newReader}`,
        ),
    );
    for (const issue of f.issues)
        assert.deepEqual(issue.assignees, ["tparsons9"]);
    for (const call of f.calls.filter((entry) => entry.method !== "GET"))
        assert.ok(call.route.startsWith(`/repos/${FORK}/`));
    const writes = f.calls.filter((call) => call.method !== "GET").length;
    await checkUpstream({ client: f.client, state });
    assert.equal(
        f.calls.filter((call) => call.method !== "GET").length,
        writes,
    );
});

test("branch commits in either repository never trigger alerts or branch-head requests", async () => {
    const f = fake({ reader: newReader, parentHead: newParent });
    const result = await checkUpstream({ client: f.client, state });
    assert.deepEqual(result.actions, []);
    assert.equal(f.issues.length, 0);
    assert.equal(f.calls.filter((call) => call.method !== "GET").length, 0);
    assert.equal(
        f.calls.some(
            (call) =>
                call.route.startsWith(`/repos/${SOURCES.reader}/`) ||
                call.route === `/repos/${SOURCES.zotflow}/commits/master`,
        ),
        false,
    );
});

test("the reader in a release alert comes from the release tree rather than reader master", async () => {
    const head = "e".repeat(40);
    const f = fake({
        parent: newParent,
        tag: "1.7.0",
        reader: head,
        readerPin: newReader,
    });
    await checkUpstream({ client: f.client, state });
    assert.equal(f.issues.length, 1);
    assert.ok(f.issues[0].body.includes(newReader));
    assert.equal(f.issues[0].body.includes(head), false);
    assert.ok(
        f.calls.some(
            (call) =>
                call.route ===
                `/repos/${SOURCES.zotflow}/git/trees/${newParent}`,
        ),
    );
    assert.equal(
        f.calls.some((call) =>
            call.route.startsWith(`/repos/${SOURCES.reader}/`),
        ),
        false,
    );
});

test("legacy reader alerts are ignored when a stable release becomes available", async () => {
    const f = fake({ parent: newParent, tag: "1.7.0" });
    const legacy = {
        number: 1,
        state: "open",
        title: "Upstream reader updates available",
        body: `<!-- zotflow-upstream:${JSON.stringify({ source: "reader", targets: [newReader] })} -->\nOld reader review notes.`,
    };
    f.issues.push(structuredClone(legacy));
    const result = await checkUpstream({ client: f.client, state });
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].source, "zotflow");
    assert.equal(result.actions[0].action, "create-issue");
    assert.equal(f.issues.length, 2);
    assert.deepEqual(f.issues[0], legacy);
});

test("dry run gathers targets without labels, comments or issue mutations", async () => {
    const f = fake({ parent: newParent, tag: "1.7.0" });
    const result = await checkUpstream({
        client: f.client,
        state,
        dryRun: true,
    });
    assert.equal(result.actions[0].action, "create-issue");
    assert.equal(
        f.calls.every((call) => call.method === "GET"),
        true,
    );
    assert.equal(f.issues.length, 0);
});

test("updates one open issue, preserves human notes, and retries failed patches without duplicate mentions", async () => {
    const f = fake({ parent: newParent, tag: "1.7.0" });
    await checkUpstream({ client: f.client, state });
    const issue = f.issues[0];
    issue.body += "\nMy review notes stay here.\n";
    const earlier = "e".repeat(40);
    issue.body = issue.body
        .replaceAll(newParent, earlier)
        .replaceAll("1.7.0", "1.6.7");
    f.setFailure((method) => method === "PATCH");
    await assert.rejects(checkUpstream({ client: f.client, state }), /503/u);
    assert.equal(f.comments.get(issue.number).length, 1);
    f.setFailure(null);
    await checkUpstream({ client: f.client, state });
    assert.equal(f.comments.get(issue.number).length, 1);
    assert.match(issue.body, /My review notes stay here/u);
    assert.ok(issue.body.includes(`1.7.0:${newParent}`));
    assert.equal(f.issues.length, 1);
});

test("closing an issue acknowledges its targets without adopting them", async () => {
    const f = fake({ parent: newParent, tag: "1.7.0" });
    await checkUpstream({ client: f.client, state });
    f.issues[0].state = "closed";
    const result = await checkUpstream({ client: f.client, state });
    assert.equal(result.actions[0].action, "already-notified");
    assert.equal(f.issues.length, 1);
    assert.equal(state.zotflow.commit, oldParent);
    assert.equal(state.reader.commit, oldReader);
});

test("API failures never become no-update results or create partial notifications", async () => {
    const f = fake({ parent: newParent, tag: "1.7.0" });
    f.setFailure((method, route) => route.includes("/git/trees/"));
    await assert.rejects(checkUpstream({ client: f.client, state }), /503/u);
    assert.equal(
        f.calls.every((call) => call.method === "GET"),
        true,
    );
});

test("a release behind the adopted upstream history is not reported as an update", async () => {
    const f = fake({
        parent: newParent,
        tag: "1.7.0",
        comparison: "behind",
    });
    const result = await checkUpstream({ client: f.client, state });
    assert.deepEqual(result.actions, []);
});

test("missing, invalid or truncated release reader pins fail before any issue writes", async () => {
    for (const options of [
        { readerPin: null },
        { readerPin: "invalid" },
        { truncated: true },
        { pinMode: "040000" },
    ]) {
        const f = fake({ parent: newParent, tag: "1.7.0", ...options });
        await assert.rejects(
            checkUpstream({ client: f.client, state }),
            /release reader pin/u,
        );
        assert.equal(
            f.calls.every((call) => call.method === "GET"),
            true,
        );
    }
});

test("fails closed for malformed provenance, prereleases, foreign execution and foreign writes", async () => {
    const f = fake();
    await assert.rejects(
        checkUpstream({ client: f.client, state, repository: SOURCES.zotflow }),
        /only runs/u,
    );
    await assert.rejects(
        checkUpstream({
            client: f.client,
            state: {
                ...state,
                reader: { ...state.reader, repository: "other/repo" },
            },
        }),
        /provenance/u,
    );
    await assert.rejects(
        checkUpstream({
            client: f.client,
            state: {
                ...state,
                reader: { ...state.reader, tracking: "master" },
            },
        }),
        /release-pinned/u,
    );
    for (const options of [
        { tag: "1.7.0-beta.1" },
        { prerelease: true },
        { draft: true },
    ]) {
        const unstable = fake(options);
        await assert.rejects(
            checkUpstream({ client: unstable.client, state }),
            /stable numeric/u,
        );
    }
    for (const route of [
        `/repos/${SOURCES.zotflow}/issues`,
        `/repos/${SOURCES.reader}/issues`,
        `/repos/${FORK}/git/refs`,
        `/repos/${FORK}/issues/../../elsewhere`,
    ]) {
        await assert.rejects(
            f.client.request("POST", route, {}),
            /Refusing writes/u,
        );
    }
    assert.equal(f.calls.length, 0);
});
