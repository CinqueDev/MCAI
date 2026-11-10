const fs = require("fs");
const { Conversation } = require("./lib/conversation");
const { setPaused } = require("./lib/pause");
const { connectionOptions, watchConnection } = require("./lib/connection");
const express = require("express");
const bodyParser = require("body-parser");
const mineflayer = require("mineflayer");

const skills = require("./lib/skillLoader");
const { initCounter, getNextTime } = require("./lib/utils");
const { worldSetupCommands } = require("./lib/compatibility");
const obs = require("./lib/observation/base");
const OnChat = require("./lib/observation/onChat");
const OnError = require("./lib/observation/onError");
const { Voxels, BlockRecords } = require("./lib/observation/voxels");
const Status = require("./lib/observation/status");
const Inventory = require("./lib/observation/inventory");
const OnSave = require("./lib/observation/onSave");
const Chests = require("./lib/observation/chests");
const { plugin: tool } = require("mineflayer-tool");

let bot = null;

const app = express();

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: false }));

app.post("/start", (req, res) => {
    if (bot) {
        if (bot.viewer) bot.viewer.close();
        bot.end();
        bot = null;
    }
    let connectionBot;
    try {
        connectionBot = mineflayer.createBot(connectionOptions(req.body));
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
    bot = connectionBot;
    const connection = watchConnection(connectionBot, (error) => {
        if (!res.headersSent) res.status(400).json({ error });
        connectionBot.end();
    }, () => {
        if (connectionBot.viewer) connectionBot.viewer.close();
        if (bot === connectionBot) bot = null;
    });

    // Event subscriptions
    connectionBot.waitTicks = req.body.waitTicks;
    connectionBot.pauseMode = req.body.pauseMode || "mod";
    connectionBot.serverPaused = false;
    connectionBot.globalTickCounter = 0;
    connectionBot.stuckTickCounter = 0;
    connectionBot.stuckPosList = [];
    connectionBot.iron_pickaxe = false;

    // mounting will cause physicsTick to stop
    connectionBot.on("mount", () => {
        connectionBot.dismount();
    });

    connectionBot.once("spawn", async () => {
        try {
            // Mineflayer installs bot.chat asynchronously during protocol setup.
            // Bind it only after the built-in plugins are ready.
            connectionBot.conversation = new Conversation(connectionBot);
            let itemTicks = 1;
            if (req.body.reset === "hard") {
                connectionBot.chat("/clear @s");
                connectionBot.chat("/kill @s");
                const inventory = req.body.inventory ? req.body.inventory : {};
                const equipment = req.body.equipment
                    ? req.body.equipment
                    : [null, null, null, null, null, null];
                for (let key in inventory) {
                    connectionBot.chat(`/give @s minecraft:${key} ${inventory[key]}`);
                    itemTicks += 1;
                }
                const equipmentNames = [
                    "armor.head",
                    "armor.chest",
                    "armor.legs",
                    "armor.feet",
                    "weapon.mainhand",
                    "weapon.offhand",
                ];
                for (let i = 0; i < 6; i++) {
                    if (i === 4) continue;
                    if (equipment[i]) {
                        connectionBot.chat(
                            `/item replace entity @s ${equipmentNames[i]} with minecraft:${equipment[i]}`
                        );
                        itemTicks += 1;
                    }
                }
            }

            if (req.body.position) {
                connectionBot.chat(
                    `/tp @s ${req.body.position.x} ${req.body.position.y} ${req.body.position.z}`
                );
            }

            // if iron_pickaxe is in connectionBot's inventory
            if (
                connectionBot.inventory.items().find((item) => item.name === "iron_pickaxe")
            ) {
                connectionBot.iron_pickaxe = true;
            }

            const { pathfinder } = require("mineflayer-pathfinder");
            const tool = require("mineflayer-tool").plugin;
            const collectBlock = require("./mineflayer-collectblock/lib").plugin;
            const pvp = require("mineflayer-pvp").plugin;
            const minecraftHawkEye = require("minecrafthawkeye").default;
            connectionBot.loadPlugin(pathfinder);
            connectionBot.loadPlugin(tool);
            connectionBot.loadPlugin(collectBlock);
            connectionBot.loadPlugin(pvp);
            connectionBot.loadPlugin(minecraftHawkEye);

            // connectionBot.collectBlock.movements.digCost = 0;
            // connectionBot.collectBlock.movements.placeCost = 0;

            obs.inject(connectionBot, [
                OnChat,
                OnError,
                Voxels,
                Status,
                Inventory,
                OnSave,
                Chests,
                BlockRecords,
            ]);
            skills.inject(connectionBot);

            if (req.body.spread) {
                connectionBot.chat(`/spreadplayers ~ ~ 0 300 under 80 false @s`);
                await connectionBot.waitForTicks(connectionBot.waitTicks);
            }

            await connectionBot.waitForTicks(connectionBot.waitTicks * itemTicks);
            if (res.headersSent) return;
            connection.ready();
            res.json(connectionBot.observe());

            initCounter(connectionBot);
            for (const command of worldSetupCommands(connectionBot.version)) {
                connectionBot.chat(command);
            }
            console.log(`Connected to Minecraft Java ${connectionBot.version}`);
        } catch (error) {
            if (!res.headersSent) res.status(400).json({ error: error.message });
            connectionBot.end();
        }
    });
});

app.post("/step", async (req, res) => {
    // import useful package
    let response_sent = false;
    function otherError(err) {
        console.log("Uncaught Error");
        bot.emit("error", handleError(err));
        bot.waitForTicks(bot.waitTicks).then(() => {
            if (!response_sent) {
                response_sent = true;
                res.json(bot.observe());
            }
        });
    }

    process.on("uncaughtException", otherError);

    const mcData = require("minecraft-data")(bot.version);
    mcData.itemsByName["leather_cap"] = mcData.itemsByName["leather_helmet"];
    mcData.itemsByName["leather_tunic"] =
        mcData.itemsByName["leather_chestplate"];
    mcData.itemsByName["leather_pants"] =
        mcData.itemsByName["leather_leggings"];
    mcData.itemsByName["leather_boots"] = mcData.itemsByName["leather_boots"];
    mcData.itemsByName["lapis_lazuli_ore"] = mcData.itemsByName["lapis_ore"];
    mcData.blocksByName["lapis_lazuli_ore"] = mcData.blocksByName["lapis_ore"];
    const {
        Movements,
        goals: {
            Goal,
            GoalBlock,
            GoalNear,
            GoalXZ,
            GoalNearXZ,
            GoalY,
            GoalGetToBlock,
            GoalLookAtBlock,
            GoalBreakBlock,
            GoalCompositeAny,
            GoalCompositeAll,
            GoalInvert,
            GoalFollow,
            GoalPlaceBlock,
        },
        pathfinder,
        Move,
        ComputedPath,
        PartiallyComputedPath,
        XZCoordinates,
        XYZCoordinates,
        SafeBlock,
        GoalPlaceBlockOptions,
    } = require("mineflayer-pathfinder");
    const { Vec3 } = require("vec3");

    // Set up pathfinder
    const movements = new Movements(bot);
    if (req.body.playerRequest) {
        movements.canDig = false;
        movements.allow1by1towers = false;
        movements.scafoldingBlocks = [];
    }
    bot.pathfinder.setMovements(movements);

    bot.globalTickCounter = 0;
    bot.stuckTickCounter = 0;
    bot.stuckPosList = [];

    function onTick() {
        bot.globalTickCounter++;
        if (bot.pathfinder.isMoving()) {
            bot.stuckTickCounter++;
            if (bot.stuckTickCounter >= 100) {
                onStuck(1.5);
                bot.stuckTickCounter = 0;
            }
        }
    }

    bot.on("physicsTick", onTick);

    // initialize fail count
    let _craftItemFailCount = 0;
    let _killMobFailCount = 0;
    let _mineBlockFailCount = 0;
    let _placeItemFailCount = 0;
    let _smeltItemFailCount = 0;

    // Retrieve array form post bod
    bot.conversation.task = req.body.task || null;
    const code = req.body.code;
    const programs = req.body.programs;
    bot.cumulativeObs = [];
    bot.actionResults = [];
    await bot.waitForTicks(bot.waitTicks);
    const r = await evaluateCode(code, programs);
    process.off("uncaughtException", otherError);
    if (r !== "success") {
        bot.emit("error", handleError(r));
    }
    // wait for last message
    await bot.waitForTicks(bot.waitTicks);
    if (!response_sent) {
        response_sent = true;
        res.json(bot.observe());
    }
    bot.removeListener("physicsTick", onTick);

    async function evaluateCode(code, programs) {
        // Echo the code produced for players to see it. Don't echo when the bot code is already producing dialog or it will double echo
        try {
            await eval("(async () => {" + programs + "\n" + code + "})()");
            return "success";
        } catch (err) {
            return err;
        }
    }

    function onStuck(posThreshold) {
        if (req.body.playerRequest) return; // No teleport recovery while visiting players.
        const currentPos = bot.entity.position;
        bot.stuckPosList.push(currentPos);

        // Check if the list is full
        if (bot.stuckPosList.length === 5) {
            const oldestPos = bot.stuckPosList[0];
            const posDifference = currentPos.distanceTo(oldestPos);

            if (posDifference < posThreshold) {
                teleportBot(); // execute the function
            }

            // Remove the oldest time from the list
            bot.stuckPosList.shift();
        }
    }

    function teleportBot() {
        const blocks = bot.findBlocks({
            matching: (block) => {
                return block.type === 0;
            },
            maxDistance: 1,
            count: 27,
        });

        if (blocks) {
            // console.log(blocks.length);
            const randomIndex = Math.floor(Math.random() * blocks.length);
            const block = blocks[randomIndex];
            bot.chat(`/tp @s ${block.x} ${block.y} ${block.z}`);
        } else {
            bot.chat("/tp @s ~ ~1.25 ~");
        }
    }

    function handleError(err) {
        let stack = err.stack;
        if (!stack) {
            return err;
        }
        console.log(stack);
        const final_line = stack.split("\n")[1];
        const regex = /<anonymous>:(\d+):\d+\)/;

        const programs_length = programs.split("\n").length;
        let match_line = null;
        for (const line of stack.split("\n")) {
            const match = regex.exec(line);
            if (match) {
                const line_num = parseInt(match[1]);
                if (line_num >= programs_length) {
                    match_line = line_num - programs_length;
                    break;
                }
            }
        }
        if (!match_line) {
            return err.message;
        }
        let f_line = final_line.match(
            /\((?<file>.*):(?<line>\d+):(?<pos>\d+)\)/
        );
        if (f_line && f_line.groups && fs.existsSync(f_line.groups.file)) {
            const { file, line, pos } = f_line.groups;
            const f = fs.readFileSync(file, "utf8").split("\n");
            // let filename = file.match(/(?<=node_modules\\)(.*)/)[1];
            let source = file + `:${line}\n${f[line - 1].trim()}\n `;

            const code_source =
                "at " +
                code.split("\n")[match_line - 1].trim() +
                " in your code";
            return source + err.message + "\n" + code_source;
        } else if (
            f_line &&
            f_line.groups &&
            f_line.groups.file.includes("<anonymous>")
        ) {
            const { file, line, pos } = f_line.groups;
            let source =
                "Your code" +
                `:${match_line}\n${code.split("\n")[match_line - 1].trim()}\n `;
            let code_source = "";
            if (line < programs_length) {
                source =
                    "In your program code: " +
                    programs.split("\n")[line - 1].trim() +
                    "\n";
                code_source = `at line ${match_line}:${code
                    .split("\n")
                    [match_line - 1].trim()} in your code`;
            }
            return source + err.message + "\n" + code_source;
        }
        return err.message;
    }
});

app.post("/observe", (req, res) => {
    if (!bot?.entity || !bot.observe) return res.status(409).json({ error: "Bot not spawned" });
    bot.waitTicks = req.body.waitTicks ?? bot.waitTicks;
    res.json(bot.observe());
});

// Independent of /step: chat remains available while generated actions await work.
app.post("/chat", (req, res) => {
    if (!bot?.conversation) return res.status(409).json({ error: "Bot not connected" });
    try {
        if (req.body.text !== undefined) return res.json(bot.conversation.send(req.body));
        res.json(bot.conversation.snapshot());
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post("/stop", (req, res) => {
    if (bot) bot.end();
    bot = null;
    res.json({
        message: "Bot stopped",
    });
});

app.post("/pause", async (req, res) => {
    const currentBot = bot;
    if (!currentBot) return res.status(400).json({ error: "Bot not spawned" });
    const paused = req.body.paused ?? !currentBot.serverPaused;
    const mode = req.body.mode || currentBot.pauseMode;
    if (typeof paused !== "boolean") return res.status(400).json({ error: "paused must be boolean" });
    try {
        if (paused !== currentBot.serverPaused) {
            await setPaused(currentBot, mode, paused);
            currentBot.serverPaused = paused;
        }
        res.json({ message: "Success", paused: currentBot.serverPaused });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Server listening to PORT 3000

const DEFAULT_PORT = 3000;
const PORT = process.argv[2] || DEFAULT_PORT;
app.listen(PORT, "127.0.0.1", () => {
    console.log(`Server started on port ${PORT}`);
});
