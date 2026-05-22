"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var promises_1 = require("fs/promises");
var path_1 = require("path");
var os_1 = require("os");
var main_js_1 = require("../main.js");
/**
 * Sets up a fetch mock that exhausts responses in order, then aborts the given
 * controller after all responses have been consumed. Returns a list of call URLs.
 */
function setupFetchMock(responses, controller) {
    var _this = this;
    var calls = [];
    var i = 0;
    globalThis.fetch = function (url) { return __awaiter(_this, void 0, void 0, function () {
        var r, json, text;
        var _this = this;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            calls.push({ url: url });
            r = responses[Math.min(i++, responses.length - 1)];
            // Abort after all planned responses have been used
            if (i >= responses.length && controller) {
                controller.abort();
            }
            json = (_a = r.bodyJson) !== null && _a !== void 0 ? _a : {};
            text = (_b = r.bodyText) !== null && _b !== void 0 ? _b : JSON.stringify(json);
            return [2 /*return*/, {
                    ok: r.ok,
                    status: (_c = r.status) !== null && _c !== void 0 ? _c : (r.ok ? 200 : 500),
                    text: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                        return [2 /*return*/, text];
                    }); }); },
                    json: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                        return [2 /*return*/, json];
                    }); }); },
                }];
        });
    }); };
    return calls;
}
function emptyUpdatesResponse() {
    return { ok: true, bodyJson: { ok: true, result: [] } };
}
function makeState(chatId, lastUpdateId) {
    if (chatId === void 0) { chatId = 123; }
    if (lastUpdateId === void 0) { lastUpdateId = -1; }
    return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] };
}
// Instant sleep for tests — no real waiting
var fastSleep = function (_ms) { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
    return [2 /*return*/];
}); }); };
// ---------------------------------------------------------------------------
// Signal: exits immediately
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: signal control', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-signal-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('exits immediately when signal is already aborted before first poll', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    controller.abort();
                    calls = setupFetchMock([], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.equal(calls.length, 0, 'fetch must not be called when signal is pre-aborted');
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Polling behaviour
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: polling', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-polling-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('polls with LONG_POLL_TIMEOUT (timeout=30) in URL', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    calls = setupFetchMock([emptyUpdatesResponse()], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('mytoken', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls.length >= 1, 'must have made at least one fetch call');
                    strict_1.default.ok(calls[0].url.includes('timeout=30'), "URL must contain timeout=30, got: ".concat(calls[0].url));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('includes correct offset in poll URL', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, 10);
                    calls = setupFetchMock([emptyUpdatesResponse()], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('mytoken', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls[0].url.includes('offset=11'), "URL must contain offset=11, got: ".concat(calls[0].url));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('uses offset=0 when last_update_id is -1 (drain-complete sentinel)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    calls = setupFetchMock([emptyUpdatesResponse()], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('mytoken', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls[0].url.includes('offset=0'), "URL must contain offset=0, got: ".concat(calls[0].url));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('loops and polls again after empty response', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    calls = setupFetchMock([
                        emptyUpdatesResponse(),
                        emptyUpdatesResponse(),
                    ], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls.length >= 2, "expected 2+ fetch calls, got ".concat(calls.length));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('uses offset N+1 on the next poll after receiving update with id N', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 9999, type: 'private' }, // wrong chat_id → skips dispatch
                            date: Math.floor(Date.now() / 1000),
                            text: 'hello',
                        },
                    };
                    calls = setupFetchMock([
                        { ok: true, bodyJson: { ok: true, result: [update] } }, // first poll: returns update 99
                        emptyUpdatesResponse(), // second poll: abort
                    ], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls.length >= 2, "expected 2+ fetch calls, got ".concat(calls.length));
                    strict_1.default.ok(calls[0].url.includes('offset=0'), "first poll should use offset=0, got: ".concat(calls[0].url));
                    strict_1.default.ok(calls[1].url.includes('offset=100'), "second poll should use offset=100 (99+1), got: ".concat(calls[1].url));
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Deferred acknowledgement
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: deferred acknowledgement', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-ack-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('persists last_update_id after all updates are processed', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, raw, saved;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 9999, type: 'private' }, // wrong chat_id → skips dispatch
                            date: Math.floor(Date.now() / 1000),
                            text: 'hello',
                        },
                    };
                    setupFetchMock([
                        { ok: true, bodyJson: { ok: true, result: [update] } },
                    ], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, (0, promises_1.readFile)((0, path_1.join)(tempDir, 'telegram-bot-state.json'), 'utf8')];
                case 2:
                    raw = _a.sent();
                    saved = JSON.parse(raw);
                    strict_1.default.equal(saved.last_update_id, 99);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('does not advance last_update_id when no updates arrive', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, raw, saved, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, 5);
                    setupFetchMock([emptyUpdatesResponse()], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, (0, promises_1.readFile)((0, path_1.join)(tempDir, 'telegram-bot-state.json'), 'utf8')];
                case 3:
                    raw = _a.sent();
                    saved = JSON.parse(raw);
                    strict_1.default.equal(saved.last_update_id, 5, 'last_update_id must not change on empty poll');
                    return [3 /*break*/, 5];
                case 4:
                    err_1 = _a.sent();
                    if (err_1.code !== 'ENOENT')
                        throw err_1;
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Error recovery
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: error recovery', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-err-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('continues looping after a single getUpdates failure', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, calls, attempt;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    calls = [];
                    attempt = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            calls.push(url);
                            attempt++;
                            if (attempt === 1)
                                throw new Error('Network failure');
                            controller.abort();
                            return [2 /*return*/, {
                                    ok: true,
                                    status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: [] })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.equal(calls.length, 2, 'must have retried after the failure');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('applies backoff between retries (verifies sleepFn is called with correct ms)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, sleepCalls, trackingSleep, attempt;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    sleepCalls = [];
                    trackingSleep = function (ms) { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                        sleepCalls.push(ms);
                        return [2 /*return*/];
                    }); }); };
                    attempt = 0;
                    globalThis.fetch = function () { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            attempt++;
                            if (attempt <= 2)
                                throw new Error('fail');
                            controller.abort();
                            return [2 /*return*/, {
                                    ok: true,
                                    status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: [] })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, trackingSleep)];
                case 1:
                    _a.sent();
                    // After error 1: backoff=5000ms; after error 2: backoff=10000ms
                    strict_1.default.equal(sleepCalls.length, 2, 'sleep must be called once per error');
                    strict_1.default.equal(sleepCalls[0], 5000, 'first backoff must be 5000ms');
                    strict_1.default.equal(sleepCalls[1], 10000, 'second backoff must be 10000ms');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('resets consecutive error count after a successful poll', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, sleepCalls, trackingSleep, attempt;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    sleepCalls = [];
                    trackingSleep = function (ms) { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                        sleepCalls.push(ms);
                        return [2 /*return*/];
                    }); }); };
                    attempt = 0;
                    globalThis.fetch = function () { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            attempt++;
                            if (attempt === 1)
                                throw new Error('fail once');
                            if (attempt === 2) {
                                // Success — resets consecutiveErrors to 0
                                return [2 /*return*/, {
                                        ok: true,
                                        status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: [] })];
                                        }); }); },
                                    }];
                            }
                            if (attempt === 3)
                                throw new Error('fail again');
                            // 4th call: succeed and abort
                            controller.abort();
                            return [2 /*return*/, {
                                    ok: true,
                                    status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: [] })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, trackingSleep)];
                case 1:
                    _a.sent();
                    // Error 1: backoff 5000ms; error 3 (after reset): backoff 5000ms again (not 10000ms)
                    strict_1.default.equal(sleepCalls.length, 2);
                    strict_1.default.equal(sleepCalls[0], 5000, 'first error backoff = 5000ms');
                    strict_1.default.equal(sleepCalls[1], 5000, 'second error after reset should also be 5000ms (counter reset)');
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// At-least-once delivery
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: at-least-once delivery', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-atleastonce-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('re-delivers updates when offset was not advanced (crash simulation)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 9999, type: 'private' }, // wrong chat_id → instant processUpdate return
                            date: Math.floor(Date.now() / 1000),
                            text: 'hello',
                        },
                    };
                    calls = setupFetchMock([
                        { ok: true, bodyJson: { ok: true, result: [update] } }, // re-delivered update 99
                        emptyUpdatesResponse(), // second poll → abort
                    ], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls.length >= 2);
                    strict_1.default.ok(calls[1].url.includes('offset=100'), "second poll should use offset=100, got: ".concat(calls[1].url));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('advances offset to batch max when multiple updates arrive', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, makeUpdate, calls, raw, saved;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    makeUpdate = function (id) { return ({
                        update_id: id,
                        message: {
                            message_id: id,
                            chat: { id: 9999, type: 'private' }, // wrong chat_id → instant return
                            date: Math.floor(Date.now() / 1000),
                            text: 'hi',
                        },
                    }); };
                    calls = setupFetchMock([
                        { ok: true, bodyJson: { ok: true, result: [makeUpdate(99), makeUpdate(100)] } },
                        emptyUpdatesResponse(),
                    ], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls.length >= 2);
                    strict_1.default.ok(calls[1].url.includes('offset=101'), "second poll should use offset=101, got: ".concat(calls[1].url));
                    return [4 /*yield*/, (0, promises_1.readFile)((0, path_1.join)(tempDir, 'telegram-bot-state.json'), 'utf8')];
                case 2:
                    raw = _a.sent();
                    saved = JSON.parse(raw);
                    strict_1.default.equal(saved.last_update_id, 100, 'last_update_id must be 100 (batch max)');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('offset still advances when update has no text (skip path)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, calls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 123, type: 'private' }, // allowed chat, but no text
                            date: Math.floor(Date.now() / 1000),
                            // text intentionally absent
                        },
                    };
                    calls = setupFetchMock([
                        { ok: true, bodyJson: { ok: true, result: [update] } },
                        emptyUpdatesResponse(),
                    ], controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(calls.length >= 2);
                    strict_1.default.ok(calls[1].url.includes('offset=100'), "second poll should use offset=100, got: ".concat(calls[1].url));
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Graceful shutdown: sentinel file
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: graceful shutdown', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-shutdown-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('exits when sentinel file is detected at top of loop', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, sentinelPath, fetchCallCount;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState();
                    sentinelPath = (0, path_1.join)(tempDir, 'telegram-bot.stop');
                    fetchCallCount = 0;
                    globalThis.fetch = function () { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    fetchCallCount++;
                                    // Write sentinel after the first getUpdates call so next iteration detects it
                                    return [4 /*yield*/, (0, promises_1.writeFile)(sentinelPath, 'stop', 'utf8')];
                                case 1:
                                    // Write sentinel after the first getUpdates call so next iteration detects it
                                    _a.sent();
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                            }); }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: [] })];
                                            }); }); },
                                        }];
                            }
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep, sentinelPath)];
                case 1:
                    _a.sent();
                    strict_1.default.equal(fetchCallCount, 1, 'should stop after exactly one poll (sentinel found on next iteration)');
                    strict_1.default.ok(!controller.signal.aborted, 'AbortController must not be aborted — sentinel drove the shutdown');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('exits immediately when sentinel already exists before first poll', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, sentinelPath, fetchCallCount;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState();
                    sentinelPath = (0, path_1.join)(tempDir, 'telegram-bot.stop');
                    return [4 /*yield*/, (0, promises_1.writeFile)(sentinelPath, 'stop', 'utf8')];
                case 1:
                    _a.sent();
                    fetchCallCount = 0;
                    globalThis.fetch = function () { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            fetchCallCount++;
                            controller.abort();
                            return [2 /*return*/, {
                                    ok: true, status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: [] })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep, sentinelPath)];
                case 2:
                    _a.sent();
                    strict_1.default.equal(fetchCallCount, 0, 'fetch must not be called when sentinel already exists');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('does not count AbortError as a consecutive error (no backoff on graceful abort)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, sleepCalls, trackingSleep;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    sleepCalls = [];
                    trackingSleep = function (ms) { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                        sleepCalls.push(ms);
                        return [2 /*return*/];
                    }); }); };
                    globalThis.fetch = function () { return __awaiter(void 0, void 0, void 0, function () {
                        var err;
                        return __generator(this, function (_a) {
                            controller.abort();
                            err = new Error('The operation was aborted.');
                            err.name = 'AbortError';
                            throw err;
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, trackingSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.equal(sleepCalls.length, 0, 'AbortError must not trigger backoff sleep');
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Parallel processing: cross-topic concurrency
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: parallel processing', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-parallel-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('poll continues immediately — second getUpdates fires before sendMessage resolves', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, urlOrder, getUpdatesCallCount, getUpdatesIndices, sendMessageIndex;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 123, type: 'private' }, // allowed chat
                            date: Math.floor(Date.now() / 1000),
                            text: '/default',
                        },
                    };
                    urlOrder = [];
                    getUpdatesCallCount = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            urlOrder.push(url);
                            if (url.includes('getUpdates')) {
                                getUpdatesCallCount++;
                                if (getUpdatesCallCount === 1) {
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, JSON.stringify({ ok: true, result: [update] })];
                                            }); }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: [update] })];
                                            }); }); },
                                        }];
                                }
                                // Second getUpdates: abort (loop exits, drain begins) and return empty
                                controller.abort();
                                return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: [] })];
                                        }); }); },
                                    }];
                            }
                            // setMessageReaction, sendMessage, setWebhook, etc.
                            return [2 /*return*/, {
                                    ok: true, status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: true })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: true })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    getUpdatesIndices = urlOrder
                        .map(function (u, i) { return u.includes('getUpdates') ? i : -1; })
                        .filter(function (i) { return i >= 0; });
                    sendMessageIndex = urlOrder.findIndex(function (u) { return u.includes('sendMessage'); });
                    strict_1.default.ok(getUpdatesIndices.length >= 2, "expected 2+ getUpdates calls, got ".concat(getUpdatesIndices.length));
                    strict_1.default.ok(sendMessageIndex >= 0, 'sendMessage must have been called');
                    strict_1.default.ok(getUpdatesIndices[1] < sendMessageIndex, "second getUpdates (call order ".concat(getUpdatesIndices[1], ") must precede sendMessage (call order ").concat(sendMessageIndex, "); full order: ").concat(urlOrder.map(function (u) { var _a; return (_a = u.split('/').pop()) === null || _a === void 0 ? void 0 : _a.split('?')[0]; }).join(', ')));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('graceful shutdown drains in-flight processUpdate before returning', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, releaseSendMessage, sendMessageGate, getUpdatesCallCount, loopDone, loopPromise, i;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 123, type: 'private' }, // allowed chat
                            date: Math.floor(Date.now() / 1000),
                            text: '/model claude',
                        },
                    };
                    sendMessageGate = new Promise(function (resolve) { releaseSendMessage = resolve; });
                    getUpdatesCallCount = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    if (url.includes('getUpdates')) {
                                        getUpdatesCallCount++;
                                        if (getUpdatesCallCount === 1) {
                                            return [2 /*return*/, {
                                                    ok: true, status: 200,
                                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [update] })];
                                                    }); }); },
                                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, ({ ok: true, result: [update] })];
                                                    }); }); },
                                                }];
                                        }
                                        // Second getUpdates: abort → loop exits into drain phase
                                        controller.abort();
                                        return [2 /*return*/, {
                                                ok: true, status: 200,
                                                text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                    return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                                }); }); },
                                                json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                    return [2 /*return*/, ({ ok: true, result: [] })];
                                                }); }); },
                                            }];
                                    }
                                    if (!url.includes('sendMessage')) return [3 /*break*/, 2];
                                    // Block until the test releases — keeps processUpdate in flight
                                    return [4 /*yield*/, sendMessageGate];
                                case 1:
                                    // Block until the test releases — keeps processUpdate in flight
                                    _a.sent();
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, JSON.stringify({ ok: true, result: { message_id: 2 } })];
                                            }); }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: { message_id: 2 } })];
                                            }); }); },
                                        }];
                                case 2: 
                                // setMessageReaction etc.
                                return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: true })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: true })];
                                        }); }); },
                                    }];
                            }
                        });
                    }); };
                    loopDone = false;
                    loopPromise = (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)
                        .then(function () { loopDone = true; });
                    i = 0;
                    _a.label = 1;
                case 1:
                    if (!(i < 10)) return [3 /*break*/, 4];
                    return [4 /*yield*/, new Promise(function (resolve) { return setImmediate(resolve); })];
                case 2:
                    _a.sent();
                    _a.label = 3;
                case 3:
                    i++;
                    return [3 /*break*/, 1];
                case 4:
                    strict_1.default.equal(loopDone, false, 'runPollLoop must not return while processUpdate is in flight (blocked at sendMessage)');
                    // Release sendMessage — processUpdate can now complete
                    releaseSendMessage();
                    return [4 /*yield*/, loopPromise];
                case 5:
                    _a.sent();
                    strict_1.default.equal(loopDone, true, 'runPollLoop must return after processUpdate completes');
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('uses timeout=0 in getUpdates URL when updates are in-flight', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, releaseSendMessage, sendMessageGate, getUpdatesUrls, getUpdatesCallCount;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 123, type: 'private' },
                            date: Math.floor(Date.now() / 1000),
                            text: '/model claude',
                        },
                    };
                    sendMessageGate = new Promise(function (resolve) { releaseSendMessage = resolve; });
                    getUpdatesUrls = [];
                    getUpdatesCallCount = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    if (url.includes('getUpdates')) {
                                        getUpdatesUrls.push(url);
                                        getUpdatesCallCount++;
                                        if (getUpdatesCallCount === 1) {
                                            return [2 /*return*/, {
                                                    ok: true, status: 200,
                                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [update] })];
                                                    }); }); },
                                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, ({ ok: true, result: [update] })];
                                                    }); }); },
                                                }];
                                        }
                                        // Second getUpdates fires while sendMessage is still blocked → abort
                                        controller.abort();
                                        releaseSendMessage();
                                        return [2 /*return*/, {
                                                ok: true, status: 200,
                                                text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                    return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                                }); }); },
                                                json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                    return [2 /*return*/, ({ ok: true, result: [] })];
                                                }); }); },
                                            }];
                                    }
                                    if (!url.includes('sendMessage')) return [3 /*break*/, 2];
                                    return [4 /*yield*/, sendMessageGate];
                                case 1:
                                    _a.sent();
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, JSON.stringify({ ok: true, result: { message_id: 2 } })];
                                            }); }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: { message_id: 2 } })];
                                            }); }); },
                                        }];
                                case 2: return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: true })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: true })];
                                        }); }); },
                                    }];
                            }
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(getUpdatesUrls.length >= 2, "expected 2+ getUpdates calls, got ".concat(getUpdatesUrls.length));
                    strict_1.default.ok(getUpdatesUrls[0].includes('timeout=30'), "first getUpdates (idle) must use timeout=30; got: ".concat(getUpdatesUrls[0]));
                    strict_1.default.ok(getUpdatesUrls[1].includes('timeout=0'), "second getUpdates (in-flight) must use timeout=0; got: ".concat(getUpdatesUrls[1]));
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('sleeps 500ms after empty short-poll when in-flight', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, state, update, releaseSendMessage, sendMessageGate, sleepCalls, trackingSleep, getUpdatesCallCount;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 99,
                        message: {
                            message_id: 1,
                            chat: { id: 123, type: 'private' },
                            date: Math.floor(Date.now() / 1000),
                            text: '/model claude',
                        },
                    };
                    sendMessageGate = new Promise(function (resolve) { releaseSendMessage = resolve; });
                    sleepCalls = [];
                    trackingSleep = function (ms) { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                        sleepCalls.push(ms);
                        return [2 /*return*/];
                    }); }); };
                    getUpdatesCallCount = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    if (url.includes('getUpdates')) {
                                        getUpdatesCallCount++;
                                        if (getUpdatesCallCount === 1) {
                                            // First call: returns the update, triggers processUpdate
                                            return [2 /*return*/, {
                                                    ok: true, status: 200,
                                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [update] })];
                                                    }); }); },
                                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, ({ ok: true, result: [update] })];
                                                    }); }); },
                                                }];
                                        }
                                        if (getUpdatesCallCount === 2) {
                                            // Second call: empty — should trigger 500ms sleep
                                            return [2 /*return*/, {
                                                    ok: true, status: 200,
                                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                                    }); }); },
                                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                        return [2 /*return*/, ({ ok: true, result: [] })];
                                                    }); }); },
                                                }];
                                        }
                                        // Third call: abort and release sendMessage
                                        controller.abort();
                                        releaseSendMessage();
                                        return [2 /*return*/, {
                                                ok: true, status: 200,
                                                text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                    return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                                }); }); },
                                                json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                    return [2 /*return*/, ({ ok: true, result: [] })];
                                                }); }); },
                                            }];
                                    }
                                    if (!url.includes('sendMessage')) return [3 /*break*/, 2];
                                    return [4 /*yield*/, sendMessageGate];
                                case 1:
                                    _a.sent();
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, JSON.stringify({ ok: true, result: { message_id: 2 } })];
                                            }); }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: { message_id: 2 } })];
                                            }); }); },
                                        }];
                                case 2: return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: true })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: true })];
                                        }); }); },
                                    }];
                            }
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, trackingSleep)];
                case 1:
                    _a.sent();
                    strict_1.default.ok(sleepCalls.includes(500), "expected a 500ms sleep call when in-flight + empty response; got sleepCalls=".concat(JSON.stringify(sleepCalls)));
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// Model expiry: pin expiry notification
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: model expiry pin', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-expiry-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('pins expiry notification when model preference expires', function () { return __awaiter(void 0, void 0, void 0, function () {
        var topicStateFile, yesterday, topicState, controller, state, update, calledUrls, getUpdatesCount, unpinCalls, pinCalls;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    topicStateFile = (0, path_1.join)(tempDir, 'telegram-bot-topic-123_0.json');
                    yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                    topicState = {
                        chat_id: 123,
                        thread_id: 0,
                        turns: [],
                        preferred_worker: 'gemini',
                        preferred_worker_set_at: yesterday,
                        pinned_model_message_id: 42,
                    };
                    return [4 /*yield*/, (0, promises_1.writeFile)(topicStateFile, JSON.stringify(topicState), 'utf8')];
                case 1:
                    _a.sent();
                    controller = new AbortController();
                    state = makeState(123, -1);
                    update = {
                        update_id: 1,
                        message: {
                            message_id: 10,
                            chat: { id: 123, type: 'private' },
                            date: Math.floor(Date.now() / 1000),
                            text: 'hello',
                        },
                    };
                    calledUrls = [];
                    getUpdatesCount = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            calledUrls.push(url);
                            if (url.includes('getUpdates')) {
                                getUpdatesCount++;
                                if (getUpdatesCount === 1) {
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, JSON.stringify({ ok: true, result: [update] })];
                                            }); }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: [update] })];
                                            }); }); },
                                        }];
                                }
                                controller.abort();
                                return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: [] })];
                                        }); }); },
                                    }];
                            }
                            // sendMessage returns a message_id so pinChatMessage can be called
                            if (url.includes('sendMessage')) {
                                return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: { message_id: 99 } })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: { message_id: 99 } })];
                                        }); }); },
                                    }];
                            }
                            return [2 /*return*/, {
                                    ok: true, status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: true })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: true })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], state, {}, controller.signal, fastSleep)];
                case 2:
                    _a.sent();
                    unpinCalls = calledUrls.filter(function (u) { return u.includes('unpinChatMessage'); });
                    pinCalls = calledUrls.filter(function (u) { return u.includes('/pinChatMessage'); });
                    strict_1.default.strictEqual(unpinCalls.length, 1, 'should unpin the old model indicator');
                    strict_1.default.strictEqual(pinCalls.length, 1, 'should pin the expiry notification');
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// DLQ: write on send failure / no write on success / no addTurn on failure
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: DLQ', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-poll-dlq-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    /** URL-aware fetch: sendMessage fails with Forbidden; everything else succeeds. */
    function setupUrlAwareFetch(controller) {
        var _this = this;
        var getUpdatesCount = 0;
        var update = {
            update_id: 1,
            message: {
                message_id: 10,
                chat: { id: 123, type: 'private' },
                date: Math.floor(Date.now() / 1000),
                text: '/default',
            },
        };
        globalThis.fetch = function (url) { return __awaiter(_this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                if (url.includes('getUpdates')) {
                    getUpdatesCount++;
                    if (getUpdatesCount === 1) {
                        return [2 /*return*/, {
                                ok: true, status: 200,
                                text: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                                    return [2 /*return*/, JSON.stringify({ ok: true, result: [update] })];
                                }); }); },
                                json: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                                    return [2 /*return*/, ({ ok: true, result: [update] })];
                                }); }); },
                            }];
                    }
                    controller.abort();
                    return [2 /*return*/, {
                            ok: true, status: 200,
                            text: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                                return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                            }); }); },
                            json: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                                return [2 /*return*/, ({ ok: true, result: [] })];
                            }); }); },
                        }];
                }
                if (url.includes('sendMessage')) {
                    return [2 /*return*/, {
                            ok: false, status: 400,
                            text: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                                return [2 /*return*/, 'Forbidden'];
                            }); }); },
                            json: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                                return [2 /*return*/, ({ ok: false })];
                            }); }); },
                        }];
                }
                // setMessageReaction, sendChatAction, etc.
                return [2 /*return*/, {
                        ok: true, status: 200,
                        text: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                            return [2 /*return*/, JSON.stringify({ ok: true, result: true })];
                        }); }); },
                        json: function () { return __awaiter(_this, void 0, void 0, function () { return __generator(this, function (_a) {
                            return [2 /*return*/, ({ ok: true, result: true })];
                        }); }); },
                    }];
            });
        }); };
    }
    (0, node_test_1.it)('writes to DLQ when sendMessage fails', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, dlqPath, raw, entry;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    setupUrlAwareFetch(controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    dlqPath = (0, path_1.join)(tempDir, 'telegram-dlq.jsonl');
                    return [4 /*yield*/, (0, promises_1.readFile)(dlqPath, 'utf8')];
                case 2:
                    raw = _a.sent();
                    entry = JSON.parse(raw.trim());
                    strict_1.default.equal(entry.chatId, 123);
                    strict_1.default.ok(typeof entry.text === 'string' && entry.text.length > 0, 'DLQ entry must have text');
                    strict_1.default.equal(entry.updateId, 1);
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('does not write to DLQ when sendMessage succeeds', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, update, getUpdatesCount, dlqPath;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    update = {
                        update_id: 1,
                        message: {
                            message_id: 10,
                            chat: { id: 123, type: 'private' },
                            date: Math.floor(Date.now() / 1000),
                            text: '/default',
                        },
                    };
                    getUpdatesCount = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            if (url.includes('getUpdates')) {
                                getUpdatesCount++;
                                if (getUpdatesCount === 1) {
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, JSON.stringify({ ok: true, result: [update] })];
                                            }); }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: [update] })];
                                            }); }); },
                                        }];
                                }
                                controller.abort();
                                return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: [] })];
                                        }); }); },
                                    }];
                            }
                            return [2 /*return*/, {
                                    ok: true, status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: { message_id: 1 } })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: { message_id: 1 } })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    dlqPath = (0, path_1.join)(tempDir, 'telegram-dlq.jsonl');
                    return [4 /*yield*/, strict_1.default.rejects(function () { return (0, promises_1.stat)(dlqPath); }, /ENOENT/, 'DLQ file must not exist when sendMessage succeeds')];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('does not addTurn when sendMessage fails', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, topicStateFile, topicState, raw, _a, assistantTurns;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    controller = new AbortController();
                    setupUrlAwareFetch(controller);
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _c.sent();
                    topicStateFile = (0, path_1.join)(tempDir, 'telegram-bot-topic-123_0.json');
                    topicState = {};
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, (0, promises_1.readFile)(topicStateFile, 'utf8')];
                case 3:
                    raw = _c.sent();
                    topicState = JSON.parse(raw);
                    return [3 /*break*/, 5];
                case 4:
                    _a = _c.sent();
                    return [3 /*break*/, 5];
                case 5:
                    assistantTurns = ((_b = topicState.turns) !== null && _b !== void 0 ? _b : []).filter(function (t) { return t.role === 'assistant'; });
                    strict_1.default.equal(assistantTurns.length, 0, 'no assistant turn must be recorded when sendMessage fails');
                    return [2 /*return*/];
            }
        });
    }); });
});
// ---------------------------------------------------------------------------
// restart_bot: sentinel ordering regression
// ---------------------------------------------------------------------------
// Note: Testing the ordering invariant (sentinel written AFTER sendMessage)
// requires mocking dispatchMessage, which spawns real pa worker processes and
// cannot be intercepted via fetch. The ordering is enforced by source structure
// in main.ts (sentinel write follows saveTopicState which follows sendMessage).
// The applyMetaActions contract (restartBot=true when restart_bot action fires)
// is covered by logic.test.ts. This block covers the regression: normal message
// paths must never write the sentinel.
// ---------------------------------------------------------------------------
(0, node_test_1.describe)('runPollLoop: restart_bot sentinel', { concurrency: 1 }, function () {
    var tempDir;
    var savedFetch = globalThis.fetch;
    (0, node_test_1.beforeEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, promises_1.mkdtemp)((0, path_1.join)((0, os_1.tmpdir)(), 'tgbot-sentinel-'))];
                case 1:
                    tempDir = _a.sent();
                    process.env.PA_HOME = tempDir;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.afterEach)(function () { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    delete process.env.PA_HOME;
                    return [4 /*yield*/, (0, promises_1.rm)(tempDir, { recursive: true, force: true })];
                case 1:
                    _a.sent();
                    globalThis.fetch = savedFetch;
                    return [2 /*return*/];
            }
        });
    }); });
    (0, node_test_1.it)('does not write sentinel for normal /model switch (no restart_bot action)', function () { return __awaiter(void 0, void 0, void 0, function () {
        var controller, getUpdatesCount, sentinelPath;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    controller = new AbortController();
                    getUpdatesCount = 0;
                    globalThis.fetch = function (url) { return __awaiter(void 0, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            if (url.includes('getUpdates')) {
                                getUpdatesCount++;
                                if (getUpdatesCount === 1) {
                                    return [2 /*return*/, {
                                            ok: true, status: 200,
                                            text: function () { return __awaiter(void 0, void 0, void 0, function () {
                                                return __generator(this, function (_a) {
                                                    return [2 /*return*/, JSON.stringify({ ok: true, result: [{
                                                                    update_id: 1,
                                                                    message: {
                                                                        message_id: 10,
                                                                        chat: { id: 123, type: 'private' },
                                                                        date: Math.floor(Date.now() / 1000),
                                                                        text: '/model claude',
                                                                    },
                                                                }] })];
                                                });
                                            }); },
                                            json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                                return [2 /*return*/, ({ ok: true, result: [] })];
                                            }); }); },
                                        }];
                                }
                                controller.abort();
                                return [2 /*return*/, {
                                        ok: true, status: 200,
                                        text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, JSON.stringify({ ok: true, result: [] })];
                                        }); }); },
                                        json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                            return [2 /*return*/, ({ ok: true, result: [] })];
                                        }); }); },
                                    }];
                            }
                            // sendMessage, sendChatAction, setMessageReaction, pinChatMessage, etc.
                            return [2 /*return*/, {
                                    ok: true, status: 200,
                                    text: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, JSON.stringify({ ok: true, result: { message_id: 1 } })];
                                    }); }); },
                                    json: function () { return __awaiter(void 0, void 0, void 0, function () { return __generator(this, function (_a) {
                                        return [2 /*return*/, ({ ok: true, result: { message_id: 1 } })];
                                    }); }); },
                                }];
                        });
                    }); };
                    return [4 /*yield*/, (0, main_js_1.runPollLoop)('token', [123], makeState(), {}, controller.signal, fastSleep)];
                case 1:
                    _a.sent();
                    sentinelPath = (0, path_1.join)(tempDir, 'telegram-bot.stop');
                    return [4 /*yield*/, strict_1.default.rejects(function () { return (0, promises_1.stat)(sentinelPath); }, /ENOENT/, 'sentinel must not be written for non-restart_bot paths')];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
});
