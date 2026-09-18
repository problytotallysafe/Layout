import test from "node:test";
import assert from "node:assert/strict";
import {
  attachOpeningToNearestHost,
  moveHostedOpening,
  reflowRoomHostedOpenings,
  reflowWallHostedOpenings,
  type HostableItem,
} from "../src/lib/layout-hosting.ts";

const room = [
  { x: 0, y: 0 },
  { x: 120, y: 0 },
  { x: 120, y: 96 },
  { x: 0, y: 96 },
];

test("new openings attach to the nearest interior wall", () => {
  const wall: HostableItem = {
    id: "wall-1",
    type: "wall",
    start: { x: 60, y: 0 },
    end: { x: 60, y: 96 },
    thickness: 4.5,
  };
  const opening: HostableItem = {
    id: "opening-1",
    type: "opening",
    start: { x: 58, y: 30 },
    end: { x: 58, y: 66 },
    thickness: 4.5,
  };
  const attached = attachOpeningToNearestHost(opening, [wall], room);
  assert.equal(attached.hostId, "wall-1");
  assert.equal(attached.hostEdgeIndex, undefined);
  assert.ok(Math.abs(attached.start.x - 60) < 0.001);
  assert.ok(Math.abs(attached.end.x - 60) < 0.001);
});

test("room-edge openings follow their room edge", () => {
  const opening: HostableItem = {
    id: "opening-1",
    type: "opening",
    start: { x: 40, y: 0 },
    end: { x: 76, y: 0 },
    thickness: 4.5,
    hostEdgeIndex: 0,
    hostT: 0.5,
  };
  const resizedRoom = [
    { x: 0, y: 10 },
    { x: 140, y: 10 },
    { x: 140, y: 96 },
    { x: 0, y: 96 },
  ];
  const [updated] = reflowRoomHostedOpenings([opening], resizedRoom);
  assert.ok(Math.abs(updated.start.y - 10) < 0.001);
  assert.ok(Math.abs(updated.end.y - 10) < 0.001);
});

test("openings move with an interior wall edit", () => {
  const wall: HostableItem = {
    id: "wall-1",
    type: "wall",
    start: { x: 60, y: 0 },
    end: { x: 60, y: 96 },
    thickness: 4.5,
  };
  const opening = attachOpeningToNearestHost<HostableItem>({
    id: "opening-1",
    type: "opening",
    start: { x: 60, y: 30 },
    end: { x: 60, y: 66 },
    thickness: 4.5,
  }, [wall], room);
  const movedWall = {
    ...wall,
    start: { x: 70, y: 0 },
    end: { x: 70, y: 96 },
  };
  const updated = reflowWallHostedOpenings([wall, opening], wall.id, movedWall);
  const hosted = updated.find((item) => item.id === opening.id)!;
  assert.ok(Math.abs(hosted.start.x - 70) < 0.001);
  assert.ok(Math.abs(hosted.end.x - 70) < 0.001);
});

test("dragging a hosted opening keeps it on its wall", () => {
  const wall: HostableItem = {
    id: "wall-1",
    type: "wall",
    start: { x: 0, y: 40 },
    end: { x: 120, y: 40 },
    thickness: 4.5,
  };
  const opening = attachOpeningToNearestHost<HostableItem>({
    id: "opening-1",
    type: "opening",
    start: { x: 20, y: 40 },
    end: { x: 56, y: 40 },
    thickness: 4.5,
  }, [wall], room);
  const moved = moveHostedOpening(opening, [wall, opening], room, { x: 95, y: 62 });
  assert.ok(Math.abs(moved.start.y - 40) < 0.001);
  assert.ok(Math.abs(moved.end.y - 40) < 0.001);
  assert.ok(moved.end.x <= 120.001);
});
