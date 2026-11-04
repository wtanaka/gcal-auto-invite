// Runs src/Code.gs in a vm sandbox with mocked Apps Script services.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/Code.gs", import.meta.url), "utf8");

function load(overrides = {}) {
  const calls = { list: [], patch: [] };
  const sandbox = {
    CONFIG: { invitees: ["Other@Example.org"] },
    console: { log() {}, error() {} },
    Calendar: {
      Events: {
        list: (calendarId, args) => {
          calls.list.push(args);
          return overrides.pages?.[calls.list.length - 1] ?? { items: [] };
        },
        patch: (resource, calendarId, id, args) => {
          calls.patch.push({ resource, id, args });
          if (overrides.failIds?.includes(id)) throw new Error("403");
        },
      },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => overrides.locked !== true,
        releaseLock() {},
      }),
    },
    ...overrides.globals,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, calls };
}

// Arrays made inside the vm have another realm's prototype; compare as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const event = (id, extra = {}) => ({ id, summary: id, ...extra });

test("getConfig merges defaults with CONFIG", () => {
  const { sandbox } = load({
    globals: { CONFIG: { invitees: ["a@b.c"], everyHours: 6 } },
  });
  const config = sandbox.getConfig();
  assert.equal(config.everyHours, 6);
  assert.equal(config.sendUpdates, "none");
  assert.deepEqual(config.invitees, ["a@b.c"]);
});

test("filter keeps only regular events missing an invitee", () => {
  const { sandbox } = load();
  const invitees = ["other@example.org"];
  const events = [
    event("none"),
    event("empty", { attendees: [] }),
    event("has", { attendees: [{ email: "OTHER@example.org" }] }),
    event("lacks", { attendees: [{ email: "x@y.z" }] }),
    event("birthday", { eventType: "birthday" }),
    event("explicit-default", { eventType: "default" }),
  ];
  const ids = sandbox
    .filterToEventsMissingInvitee(invitees, events)
    .map((e) => e.id);
  assert.deepEqual(ids, ["none", "lacks", "explicit-default"]);
});

test("addInvitee keeps existing attendees and sets sendUpdates", () => {
  const { sandbox, calls } = load();
  const failures = sandbox.addInvitee(
    "primary",
    ["other@example.org"],
    [event("e1", { attendees: [{ email: "x@y.z" }] })],
    "none",
  );
  assert.equal(failures.length, 0);
  assert.equal(calls.patch.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.patch[0].resource.attendees)),
    [{ email: "x@y.z" }, { email: "other@example.org" }],
  );
  assert.equal(calls.patch[0].args.sendUpdates, "none");
});

test("one failing patch does not stop the others", () => {
  const { sandbox, calls } = load({ failIds: ["bad"] });
  const failures = sandbox.addInvitee(
    "primary",
    ["other@example.org"],
    [event("bad"), event("good")],
    "none",
  );
  assert.equal(calls.patch.length, 2);
  assert.deepEqual(plain(failures.map((f) => f.id)), ["bad"]);
});

test("listEvents follows nextPageToken", () => {
  const { sandbox, calls } = load({
    pages: [
      { items: [event("a")], nextPageToken: "t1" },
      { items: [event("b")] },
    ],
  });
  const events = sandbox.listEvents("primary", new Date(0), new Date(1000));
  assert.deepEqual(plain(events.map((e) => e.id)), ["a", "b"]);
  assert.equal(calls.list[0].pageToken, undefined);
  assert.equal(calls.list[1].pageToken, "t1");
});

test("addOtherEmailInvites throws after trying every event", () => {
  const { sandbox, calls } = load({
    failIds: ["bad"],
    pages: [{ items: [event("bad"), event("good")] }],
  });
  assert.throws(() => sandbox.addOtherEmailInvites(), /1 event\(s\)/);
  assert.equal(calls.patch.length, 2);
});

test("addOtherEmailInvites skips when another run holds the lock", () => {
  const { sandbox, calls } = load({ locked: true });
  sandbox.addOtherEmailInvites();
  assert.equal(calls.list.length, 0);
});
