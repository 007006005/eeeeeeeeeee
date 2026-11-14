// f.js - ogar-feeder-bot (versione con start/stop, follow, farm, virus, feed e contatore)
// Avvio: node f.js
// Comandi accettati da socket.io (evento "cmd"):
//   start / connect_server  { ip: "ws://IP:PORTA", amount: N }
//   stop
//   split | feed (eject)
//   follow { on: true|false }
//   farm   { on: true|false }
//   virus
// Stato inviato ogni secondo (evento "bot-status"): { total, loaded, ingame }

var fs = require('fs-extra');
var path = require('path');
var url = require('url');

if (!fs.existsSync('proxy.txt')) {
    console.log("INFO: did not found proxy.txt - creating it.");
    if (fs.existsSync(path.resolve(__dirname, './proxy.sample.txt'))) {
        fs.copySync(path.resolve(__dirname, './proxy.sample.txt'), 'proxy.txt');
    } else {
        fs.writeFileSync('proxy.txt', '#HTTP\n');
    }
}

var config = require('./config');

var BOT_NAME = "Youtube-IG Agar";

var AgarioClient = require('agario-client');
var WebSocket = require('ws');

var HPA = require('https-proxy-agent');
var HttpsProxyAgent = HPA.HttpsProxyAgent || HPA;
var Socks = null;
try { Socks = require('socks'); } catch (e) {}

process.setMaxListeners(0);
process.on('uncaughtException', function(err) {
    console.log(err);
});

// ---------------------------------------------------------------
// stato globale
// ---------------------------------------------------------------
var spawnCount = 0;
var bot_count = 0;
var bots = {};
var valid_player_pos = null;
var game_server_ip = null;

var HARD_MAX = config.maxBots;   // limite massimo originale
var targetBots = 0;
var followMode = false;
var farmMode = false;

// ---------------------------------------------------------------
// bot
// ---------------------------------------------------------------
function FeederBot(bot_id, agent, bot_number, server) {
    this.bot_id = bot_id;
    this.nickname = BOT_NAME;

    this.interval_id = 0;
    this.ball_id = null;
    this.server = '';
    this.stopped = false;
    this.virusUntil = 0;
    this.client = new AgarioClient('Bot_' + this.bot_id);
    this.client.debug = 0;
    this.client.agent = agent;
    this.client.headers['user-agent'] = config.userAgent;
    this.isOnFeedMission = false;
    this.lastsent = {minx: 0, miny: 0, maxx: 0, maxy: 0};
    this.onboard_client(server, bot_number);
}

FeederBot.prototype = {
    log: function(text) {
        if (config.verbosityLevel > 0) {
            console.log('Bot_' + this.bot_id + ': ' + text);
        }
    },

    reset_map_data: function() {
        var bot = this;
        bot.map_min_x = null;
        bot.map_min_y = null;
        bot.map_max_x = null;
        bot.map_max_y = null;
    },

    onboard_client: function(server, bot_number) {
        var bot = this;
        setTimeout(function() {
            bot.connect(server);
        }, config.onboardingTimer * bot_number);
    },

    connect: function(server) {
        if (this.stopped) return;

        if (config.verbosityLevel > 0) {
            this.log('Connecting to: ' + server);
        }

        if (spawnCount > config.maxBots) {
            this.log('ERROR: spawned to many bots - Increase config.maxBots for more bots.');
            return;
        }

        this.server = server;
        this.client.connect(server);
        this.attachEvents();
    },

    attachEvents: function() {
        var bot = this;

        bot.client.on('ballDisppear', function(ball_id) {
            setTimeout(function() {
                if (bot.client.balls[ball_id]) bot.client.balls[ball_id].destroy();
            }, 200);
        });

        bot.client.on('connected', function() {
            if (bot.stopped) {
                try { bot.client.disconnect(); } catch (e) {}
                return;
            }
            bot.reset_map_data();
            if (config.verbosityLevel > 0) {
                bot.log('Connection Success, spawning');
            }
            bot.client.spawn(bot.nickname);
            spawnCount++;
            socket.emit("spawn-count", spawnCount + '/' + config.maxBots);
            bot.interval_id = setInterval(function() {
                bot.recalculateTarget();
            }, 100);
        });

        bot.client.on('mapSizeLoad', function(server_minx, server_miny, server_maxx, server_maxy) {
            if (bot.valcompare(server_maxx - server_minx, server_maxy - server_miny)) {
                bot.real_minx = server_minx;
                bot.real_miny = server_miny;
                bot.real_maxx = server_maxx;
                bot.real_maxy = server_maxy;
            } else {
                if (bot.valcompare(server_minx, bot.lastsent.minx)) {
                    if (0.01 < server_maxx - bot.lastsent.maxx || -0.01 > server_maxx - bot.lastsent.maxx) {
                        bot.real_minx = server_minx;
                        bot.real_maxx = server_minx + 14142.135623730952;
                    }
                }
                if (0.01 < server_minx - bot.lastsent.minx || -0.01 > server_minx - bot.lastsent.minx) {
                    if (bot.valcompare(server_maxx, bot.lastsent.maxx)) {
                        bot.real_maxx = server_maxx;
                        bot.real_minx = server_maxx - 14142.135623730952;
                    }
                }
                if (0.01 < server_miny - bot.lastsent.miny || -0.01 > server_miny - bot.lastsent.miny) {
                    if (bot.valcompare(server_maxy, bot.lastsent.maxy)) {
                        bot.real_maxy = server_maxy;
                        bot.real_miny = server_maxy - 14142.135623730952;
                    }
                }
                if (bot.valcompare(server_miny, bot.lastsent.miny)) {
                    if (0.01 < server_maxy - bot.lastsent.maxy || -0.01 > server_maxy - bot.lastsent.maxy) {
                        bot.real_miny = server_miny;
                        bot.real_maxy = server_miny + 14142.135623730952;
                    }
                }
                if (server_minx < bot.real_minx) {
                    bot.real_minx = server_minx;
                    bot.real_maxx = server_minx + 14142.135623730952;
                }
                if (server_maxx > bot.real_maxx) {
                    bot.real_maxx = server_maxx;
                    bot.real_minx = server_maxx - 14142.135623730952;
                }
                if (server_miny < bot.real_miny) {
                    bot.real_miny = server_miny;
                    bot.real_maxy = server_miny + 14142.135623730952;
                }
                if (server_maxy > bot.real_maxy) {
                    bot.real_maxy = server_maxy;
                    bot.real_miny = server_maxy - 14142.135623730952;
                }
                bot.lastsent.minx = server_minx;
                bot.lastsent.miny = server_miny;
                bot.lastsent.maxy = server_maxy;
                bot.lastsent.maxx = server_maxx;
            }

            bot.offset_x = bot.real_minx || -7071;
            bot.offset_y = bot.real_miny || -7071;
        });

        bot.client.on('connectionError', function(e) {
            if (config.verbosityLevel > 0) {
                bot.log('Connection Failed: ' + e);
            }
        });

        bot.client.on('myNewBall', function(ball_id) {
            if (config.verbosityLevel > -1) {
                bot.log('New Cell Generated (' + ball_id + ')');
            }
        });

        bot.client.once('leaderBoardUpdate', function(old, leaders) {
            var name_array = leaders.map(function(ball_id) {
                return bot.client.balls[ball_id].name || 'unnamed';
            });
            if (config.verbosityLevel > 0) {
                bot.log('Server Leaderboard: ' + name_array.join(' - '));
            }
        });

        bot.client.on('somebodyAteSomething', function(eater_ball, eaten_ball) {
            var ball = bot.client.balls[eater_ball];
            if (!ball) return;
            if (!ball.mine) return;
        });

        bot.client.on('mineBallDestroy', function(ball_id, reason) {
            if (reason.by) {
                if (config.verbosityLevel > 0) {
                    bot.log(bot.client.balls[reason.by] + ' has killed a cell.');
                }
            }

            if (reason.reason == 'merge') {
                if (config.verbosityLevel > 1) {
                    bot.log('Merged with another cell. Bot_' + ball_id + ' now has ' + bot.client.my_balls.length + ' balls.');
                }
            } else {
                if (config.verbosityLevel > 1) {
                    bot.log('Lost a cell! Bot_' + ball_id + ' has ' + bot.client.my_balls.length + ' cells left.');
                }
            }
        });

        bot.client.on('lostMyBalls', function() {
            if (bot.stopped) return;
            if (config.verbosityLevel > 0) {
                bot.log('Has been killed, respawning.');
            }
            bot.reset_map_data();
            bot.client.spawn(bot.nickname);
            bot.isOnFeedMission = false;
        });

        bot.client.on('disconnect', function() {
            if (config.verbosityLevel > 0) {
                bot.log('Disconnected from the server.');
            }
            if (spawnCount > 0) spawnCount--;
            socket.emit("spawn-count", spawnCount + '/' + config.maxBots);
        });

        bot.client.on('reset', function() {
            clearInterval(bot.interval_id);
        });

        bot.client.on('packetError', function(packet, err, preventCrash) {
            bot.log('Packet error detected for packet: ' + packet.toString());
            bot.log('Crash will be prevented, bot will be disconnected');
            preventCrash();
        });
    },

    valcompare: function(Y, Z) {
        return 0.01 > Y - Z && -0.01 < Y - Z;
    },

    getDistanceBetweenBalls: function(ball_1, ball_2) {
        return this.getDistanceBetweenBallAndPosition(ball_1, ball_2.x, ball_2.y);
    },

    getDistanceBetweenBallAndPosition: function(ball_1, x, y) {
        return this.getDistanceBetweenPositions(ball_1.x, ball_1.y, x, y);
    },

    getDistanceBetweenPositions: function(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y1 - y2, 2));
    },

    getAvailableTransporter: function() {
        var bot = this;
        var my_ball = bot.client.balls[bot.client.my_balls[0]];
        if (!my_ball) return;

        var possible_transporter = null;

        for (var bot_id in bots) {
            var bot_ball = bots[bot_id].client.balls[bots[bot_id].client.my_balls[0]];
            if (!bot_ball) continue;
            if (bot.getDistanceBetweenBallAndPosition(my_ball, bot_ball.x, bot_ball.y) > 2000) {
                continue;
            }
            if (possible_transporter &&
                bot.getDistanceBetweenBallAndPosition(my_ball, bot_ball.x, bot_ball.y) >
                bot.getDistanceBetweenBallAndPosition(my_ball, possible_transporter.x, possible_transporter.y)) {
                continue;
            }
            if (my_ball.size / bot_ball.size > 0.8) continue;

            possible_transporter = bot_ball;
        }

        return possible_transporter;
    },

    getMassPixelRadius: function(mass) {
        return Math.ceil(Math.sqrt(100 * mass));
    },

    canSplitFeedPlayer: function(botMass, otherMass) {
        var requiredMass = otherMass * 1.25;
        return requiredMass < botMass;
    },

    playerInRange: function(my_ball, playerX, playerY, playerSize, range) {
        var bot = this;
        var bot_distance = bot.getDistanceBetweenBallAndPosition(my_ball, playerX, playerY) - bot.getMassPixelRadius(valid_player_pos.size);
        return bot_distance < range;
    },

    in_circle: function(center_x, center_y, radius, x, y) {
        var dx = x - center_x;
        var dy = y - center_y;
        return dx * dx + dy * dy <= radius * radius;
    },

    getCoordinatesOfCircleAngle: function(center_x, center_y, radius, angle) {
        var x = Math.ceil(center_x + radius * Math.cos(angle));
        var y = Math.ceil(center_y + radius * Math.sin(angle));
        return {"x": x, "y": y};
    },

    checkIfPathCrossesBall: function(from_x, from_y, dest_x, dest_y, ball_id) {
        var bot = this;
        var ball = bot.client.balls[ball_id];

        var x1 = Math.ceil(from_x);
        var y1 = Math.ceil(from_y);
        var x2 = Math.ceil(dest_x);
        var y2 = Math.ceil(dest_y);
        var dx = Math.abs(x2 - x1);
        var dy = Math.abs(y2 - y1);
        var sx = (x1 < x2) ? 1 : -1;
        var sy = (y1 < y2) ? 1 : -1;
        var err = dx - dy;
        while (!((x1 == x2) && (y1 == y2))) {
            var e2 = err << 1;
            if (e2 > -dy) {
                err -= dy;
                x1 += sx;
            }
            if (e2 < dx) {
                err += dx;
                y1 += sy;
            }

            if (bot.in_circle(ball.x, ball.y, bot.getMassPixelRadius(ball.mass), x1, y1)) {
                return true;
            }
        }
        return false;
    },

    getNearestBallOnPath: function(from_x, from_y, dest_x, dest_y) {
        var bot = this;

        for (var ball_id in bot.client.balls) {
            var ball = bot.client.balls[ball_id];
            if (!ball.virus) {
                continue;
            }

            if (bot.checkIfPathCrossesBall(from_x, from_y, dest_x, dest_y, ball_id)) {
                console.log("Path not safe: bot would die!");
                return ball_id;
            }
        }

        return null;
    },

    safeMoveTo: function(x, y) {
        var bot = this;
        var my_ball = bot.client.balls[bot.client.my_balls[0]];

        var safeX = x;
        var safeY = y;

        var nearest_obstacle = bot.getNearestBallOnPath(my_ball.x, my_ball.y, x, y);

        if (nearest_obstacle != null) {
            var ball = bot.client.balls[nearest_obstacle];
            var bestXDistance = 99999999;
            var bestX = 0;
            var bestY = 0;

            for (var i = 0; i < 360; i = i + 16) {
                var pos = bot.getCoordinatesOfCircleAngle(ball.x, ball.y, bot.getMassPixelRadius(ball.mass) + bot.getMassPixelRadius(my_ball.mass), i);
                var test_path = bot.getNearestBallOnPath(pos.x, pos.y, my_ball.x, my_ball.y);
                var test_path2 = bot.getNearestBallOnPath(pos.x, pos.y, x, y);

                if (test_path == null && test_path2 == null) {
                    var distance1 = bot.getDistanceBetweenPositions(pos.x, pos.y, my_ball.x, my_ball.y);
                    var distance2 = bot.getDistanceBetweenPositions(pos.x, pos.y, x, y);
                    var totalDistance = distance1 + distance2;
                    if (totalDistance < bestXDistance) {
                        bestXDistance = totalDistance;
                        bestX = pos.x;
                        bestY = pos.y;
                    }
                }
            }

            if (bestX == 0 && bestY == 0) {
                console.log("pathfinding: impossible.");
                return;
            } else {
                safeX = bestX;
                safeY = bestY;
            }
        }

        bot.client.moveTo(safeX, safeY);
    },

    moveToPlayerPosWithOffset: function() {
        var bot = this;
        if (valid_player_pos == null) { return; }

        if (valid_player_pos["dimensions"] == null) {
            console.log("!!UPDATE USERSCRIPT!!");
            return;
        }

        var offset_x = bot.offset_x + 7071;
        var offset_y = bot.offset_y + 7071;

        bot.client.moveTo(valid_player_pos["x"] + offset_x, valid_player_pos["y"] + offset_y);
    },

    getCandidateBall: function() {
        var bot = this;
        var candidate_ball = null;
        var candidate_distance = 0;
        var my_ball = bot.client.balls[bot.client.my_balls[0]];

        for (var ball_id in bot.client.balls) {
            var ball = bot.client.balls[ball_id];
            if (ball.virus) {
                if (config.verbosityLevel > 1) { bot.log('virus ( green ball ) has been spotted.'); }
                continue;
            }

            if (!ball.visible) continue;
            if (ball.mine) continue;

            if (config.botMode == "blind") {
                if (valid_player_pos == null || valid_player_pos["suicide_targets"] == null) {
                    console.log("!!UPDATE USERSCRIPT!!");
                    return;
                }

                if (valid_player_pos["suicide_targets"].indexOf(ball.id) > -1) { return ball; }
            }

            if (ball.size / my_ball.size > 0.5) continue;
            var distance = bot.getDistanceBetweenBalls(ball, my_ball);
            if (candidate_ball && distance > candidate_distance) continue;

            candidate_ball = ball;
            candidate_distance = distance;
        }
        return candidate_ball;
    },

    getNearestVirus: function(my_ball) {
        var best = null;
        var bestDist = Infinity;
        for (var id in this.client.balls) {
            var b = this.client.balls[id];
            if (!b.virus) continue;
            var d = this.getDistanceBetweenBalls(b, my_ball);
            if (d < bestDist) { best = b; bestDist = d; }
        }
        return best;
    },

    recalculateTarget: function() {
        var bot = this;
        var candidate_ball = null;
        var my_ball = bot.client.balls[bot.client.my_balls[0]];
        if (!my_ball) return;

        // virus: vanno verso il virus piu' vicino ed espellono massa per qualche secondo
        if (bot.virusUntil && Date.now() < bot.virusUntil) {
            var v = bot.getNearestVirus(my_ball);
            if (v) {
                bot.client.moveTo(v.x, v.y);
                if (bot.getDistanceBetweenBalls(v, my_ball) < bot.getMassPixelRadius(my_ball.mass) + 300) {
                    bot.client.eject();
                }
            }
            return;
        }

        // follow: seguono solo la posizione del giocatore
        if (followMode) {
            bot.isOnFeedMission = false;
            bot.moveToPlayerPosWithOffset();
            return;
        }

        // farm: mangiano le palline vicine e non vanno a fare feed
        if (farmMode) {
            bot.isOnFeedMission = false;
            var target = bot.getCandidateBall();
            if (target) bot.client.moveTo(target.x, target.y);
            return;
        }

        if (config.botMode == "default") {

            if (valid_player_pos != null && bot.isOnFeedMission == true) {

                if (config.enableSaveMoveTo) {
                    bot.safeMoveTo(valid_player_pos["x"] + (bot.offset_x + 7071), valid_player_pos["y"] + (bot.offset_y + 7071));
                } else {
                    bot.moveToPlayerPosWithOffset();
                }

                if (bot.playerInRange(my_ball, valid_player_pos["x"], valid_player_pos["y"], valid_player_pos.size, 400)) {
                    if (bot.canSplitFeedPlayer(my_ball.mass, valid_player_pos.size)) {
                        bot.client.split();
                    }
                }

                return;
            }

            bot.candidate_ball = bot.getCandidateBall();

            var got_tranporter = false;
            var transporter = bot.getAvailableTransporter();
            if (transporter) {
                candidate_ball = transporter;
                got_tranporter = true;
            }

            if (valid_player_pos != null && my_ball.mass > config.minimumMassBeforeFeed) {
                bot.isOnFeedMission = true;
                return;
            }

            if (valid_player_pos != null && bot.playerInRange(my_ball, valid_player_pos["x"], valid_player_pos["y"], valid_player_pos.size, 1000)) {

                if (!got_tranporter ||
                    bot.getDistanceBetweenBalls(candidate_ball, my_ball) >
                    bot.getDistanceBetweenBallAndPosition(my_ball, valid_player_pos["x"], valid_player_pos["y"])
                ) {
                    bot.isOnFeedMission = true;
                    return;
                }
            }

            if (candidate_ball == null) {
                bot.moveToPlayerPosWithOffset();
            } else {
                bot.client.moveTo(candidate_ball.x, candidate_ball.y);
            }
        } else if (config.botMode == "blind") {
            candidate_ball = bot.getCandidateBall();
            if (candidate_ball) {
                bot.client.moveTo(candidate_ball.x, candidate_ball.y);
            }
        }
    }

};

// ---------------------------------------------------------------
// socket.io verso il feeder server
// ---------------------------------------------------------------
var socket = require('socket.io-client')(config.feederServer);

socket.on('pos', function(data) {
    valid_player_pos = data;
});

socket.on('cmd', function(data) {
    console.log(data);
    var b;

    if (data.name == "split") {
        for (b in bots) bots[b].client.split();

    } else if (data.name == "eject" || data.name == "feed") {
        for (b in bots) bots[b].client.eject();

    } else if (data.name == "follow") {
        followMode = !!data.on;
        if (followMode) farmMode = false;

    } else if (data.name == "farm") {
        farmMode = !!data.on;
        if (farmMode) followMode = false;

    } else if (data.name == "virus") {
        for (b in bots) bots[b].virusUntil = Date.now() + 5000;

    } else if (data.name == "stop") {
        followMode = false;
        farmMode = false;
        targetBots = 0;
        stopAllBots();

    } else if (data.name == "connect_server" || data.name == "start" || data.name == "reconnect_server") {
        if (!data.ip) {
            console.log("comando senza ip del server di gioco: bot non avviati");
            return;
        }
        stopAllBots();
        game_server_ip = String(data.ip).trim();
        if (!/^wss?:\/\//i.test(game_server_ip)) game_server_ip = "ws://" + game_server_ip;

        var n = parseInt(data.amount, 10);
        targetBots = n > 0 ? Math.min(n, HARD_MAX) : HARD_MAX;
        config.maxBots = targetBots;
        console.log("client requested " + targetBots + " bots on: " + game_server_ip);

        setTimeout(function() {
            startFeederBotOnProxies();
        }, 2000);
    }
});

socket.on('force-login', function(data) {
    console.log(data);
    if (data == "server-booted-up") {
        return;
    }
    socket.emit("login", {
        "uuid": config.client_uuid,
        "type": "server"
    });
});

// stato per il contatore dello userscript
setInterval(function() {
    var ingame = 0;
    for (var id in bots) {
        var c = bots[id].client;
        if (c && c.my_balls && c.my_balls.length > 0) ingame++;
    }
    socket.emit('bot-status', { total: targetBots, loaded: spawnCount, ingame: ingame });
}, 1000);

// ---------------------------------------------------------------
// stop
// ---------------------------------------------------------------
function stopAllBots() {
    for (var id in bots) {
        try {
            bots[id].stopped = true;
            clearInterval(bots[id].interval_id);
            bots[id].client.disconnect();
        } catch (e) {}
    }
    bots = {};
    setTimeout(function() {
        if (Object.keys(bots).length === 0) {
            bot_count = 0;
            spawnCount = 0;
        }
    }, 1500);
}

// ---------------------------------------------------------------
// proxy e avvio bot
// ---------------------------------------------------------------
var lines = fs.readFileSync(config.proxies).toString().split(/\r?\n/);

function createAgent(ip, type) {
    if (!Socks || !Socks.Agent) {
        console.log("SOCKS non supportato con la versione installata del pacchetto 'socks'");
        return null;
    }
    var data = ip.split(":");

    return new Socks.Agent({
        proxy: {
            ipaddress: data[0],
            port: parseInt(data[1]),
            type: parseInt(type)
        }
    });
}

var proxy_mode = "HTTP";

function startFeederBotOnProxies() {

    for (var proxy_line in lines) {

        var line = lines[proxy_line].trim();

        if (line == "#HTTP") {
            proxy_mode = "HTTP";
        } else if (line == "#SOCKS4") {
            proxy_mode = "SOCKS4";
        } else if (line == "#SOCKS5") {
            proxy_mode = "SOCKS5";
        }

        if (line[0] == "#" || line.length < 3) {
            continue;
        }

        // utile per testare un singolo proxy
        if (process.argv[2] != null && proxy_line != process.argv[2]) {
            continue;
        }

        console.log(proxy_mode + " ; " + line);

        try {
            var agent = null;

            if (line != "NOPROXY") {
                if (proxy_mode == "HTTP") {
                    agent = new HttpsProxyAgent("http://" + line);
                } else if (proxy_mode == "SOCKS4") {
                    agent = createAgent(line, 4);
                } else if (proxy_mode == "SOCKS5") {
                    agent = createAgent(line, 5);
                }
            }

            console.log("Attempting connection to " + game_server_ip);
            for (var i = 0; i < config.botsPerIp; i++) {
                if (bot_count < config.maxBots) {
                    bot_count++;
                    bots[bot_count] = new FeederBot(bot_count, agent, bot_count, game_server_ip);
                }
            }

        } catch (e) {
            console.log('Error occured on startup: ' + e);
        }
    }
}

console.log("ogar-feeder-bot started! Usa il pannello dello userscript: imposta il server di gioco e premi Start.");
console.log("Press CTRL + C to stop this script.");
