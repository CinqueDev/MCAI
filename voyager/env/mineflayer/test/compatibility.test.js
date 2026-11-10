const { test } = require("node:test");
const assert = require("node:assert/strict");
const { worldSetupCommands } = require("../lib/compatibility");

test("setup commands keep legacy names through Java 1.21.9", () => {
    for (const version of ["1.19", "1.20.6", "1.21.8", "1.21.9"]) {
        assert.deepEqual(worldSetupCommands(version), [
            "/gamerule keepInventory true", "/gamerule doDaylightCycle false",
        ]);
    }
});

test("setup commands use registry names from Java 1.21.11, including 26.x", () => {
    for (const version of ["1.21.11", "26.1"]) {
        assert.deepEqual(worldSetupCommands(version), [
            "/gamerule minecraft:keep_inventory true", "/gamerule minecraft:advance_time false",
        ]);
    }
});
