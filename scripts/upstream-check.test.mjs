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
    reader: { repository: SOURCES.reader, branch: "master", commit: oldReader },
};

function fake({
    parent = oldParent,
    reader = oldReader,
    tag = "1.6.6",
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
                data = { tag_name: tag, draft: false, prerelease: false };
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
                    truncated: false,
                    tree: [
                        {
                            path: "reader/reader",
                            mode: "160000",
                            sha: newReader,
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

test("new parent release and reader commits create separate assigned issues only in the fork", async () => {
    const f = fake({ parent: newParent, reader: newReader, tag: "1.7.0" });
    const result = await checkUpstream({ client: f.client, state });
    assert.deepEqual(
        result.actions.map((action) => action.action),
        ["create-issue", "create-issue"],
    );
    assert.equal(f.issues.length, 2);
    assert.match(f.issues[0].body, /pins reader commit/u);
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

test("reader-only changes notify even without any reader release", async () => {
    const f = fake({ reader: newReader });
    await checkUpstream({ client: f.client, state });
    assert.equal(f.issues.length, 1);
    assert.match(f.issues[0].title, /reader updates/u);
    assert.equal(
        f.calls.some(
            (call) => call.route === `/repos/${SOURCES.reader}/releases/latest`,
        ),
        false,
    );
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
    const f = fake({ reader: newReader });
    await checkUpstream({ client: f.client, state });
    const issue = f.issues[0];
    issue.body += "\nMy review notes stay here.\n";
    const earlier = "e".repeat(40);
    issue.body = issue.body.replaceAll(newReader, earlier);
    f.setFailure((method) => method === "PATCH");
    await assert.rejects(checkUpstream({ client: f.client, state }), /503/u);
    assert.equal(f.comments.get(issue.number).length, 1);
    f.setFailure(null);
    await checkUpstream({ client: f.client, state });
    assert.equal(f.comments.get(issue.number).length, 1);
    assert.match(issue.body, /My review notes stay here/u);
    assert.ok(issue.body.includes(newReader));
    assert.equal(f.issues.length, 1);
});

test("closing an issue acknowledges its targets without adopting them", async () => {
    const f = fake({ reader: newReader });
    await checkUpstream({ client: f.client, state });
    f.issues[0].state = "closed";
    const result = await checkUpstream({ client: f.client, state });
    assert.equal(result.actions[0].action, "already-notified");
    assert.equal(f.issues.length, 1);
    assert.equal(state.reader.commit, oldReader);
});

test("API failures never become no-update results or create partial notifications", async () => {
    const f = fake({ parent: newParent, tag: "1.7.0" });
    f.setFailure(
        (method, route) => route === `/repos/${SOURCES.reader}/commits/master`,
    );
    await assert.rejects(checkUpstream({ client: f.client, state }), /503/u);
    assert.equal(
        f.calls.every((call) => call.method === "GET"),
        true,
    );
});

test("already-integrated reader history is not reported as an update", async () => {
    const f = fake({ reader: newReader, comparison: "behind" });
    const result = await checkUpstream({ client: f.client, state });
    assert.deepEqual(result.actions, []);
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
    const beta = fake({ tag: "1.7.0-beta.1" });
    await assert.rejects(
        checkUpstream({ client: beta.client, state }),
        /stable numeric/u,
    );
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
