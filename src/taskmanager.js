const assert = require("assert");

const inBrowser = (typeof window !== "undefined");
let NodeWorker;
if (!inBrowser) {
    NodeWorker = require("worker_threads").Worker;
}

class Deferred {
    constructor() {
        this.promise = new Promise((resolve, reject)=> {
            this.reject = reject;
            this.resolve = resolve;
        });
    }
}


function thread(self, fn, modules) {

    const ctx = {
        modules: modules
    };

    self.onmessage = function(e) {
        let data;
        if (e.data) {
            data = e.data;
        } else {
            data = e;
        }

        if (data.cmd == "INIT") {
            ctx.processId = data.processId;
        }


        if (data.cmd == "TERMINATE") {
            self.postMessage({cmd: "TERMINATE"});
            process.exit();
            return;
        }

        let res = fn(ctx, data);

        res = res || {};

        res.cmd = data.cmd;

        if (res) {
            if (res.buff) {
                res.buff = new Uint8Array(res.buff);
                self.postMessage(res, [res.buff.buffer]);
            } else {
                self.postMessage(res);
            }
        }
    };

}


async function buildTaskManager(fn, mods, initTask) {

    let concurrency;
    if ((typeof(navigator) === "object") && navigator.hardwareConcurrency) {
        concurrency = navigator.hardwareConcurrency;
    } else {
        const os = require("os");
        concurrency = os.cpus().length;
    }

    const tm = {
        workers: []
    };

    let S = "{";
    const keys = Object.keys(mods);
    for (let i=0; i<keys.length; i++) {
        const key= keys[i];
        S += `${key}: require('${mods[key]}'), `;
    }
    S += "}";


    function getOnMsg(i) {

        return function(e) {

            function finishTask() {
                // It can  not be a waiting task and it's terminating
                assert( !(tm.waitingTask && tm.terminateDeferred));

                if (tm.terminateDeferred) {
                    tm.workers[i].worker.postMessage({cmd: "TERMINATE"});
                    return;
                }

                tm.workers[i].state = "READY";

                if (tm.waitingTask) {
                    processTask(i, tm.waitingTask.task, tm.waitingTask.asyncCb);
                    const d = tm.waitingTask.deferral;
                    tm.waitingTask = null;
                    d.resolve();
                }

            }

            let data;
            if ((e)&&(e.data)) {
                data = e.data;
            } else {
                data = e;
            }

            if (data.cmd == "TERMINATE") {
                tm.workers[i].state = "TERMINATED";
                tm.tryTerminate();
                return;
            }

            if (data.buff) {
                data.buff = Buffer.from(data.buff);
            }

            if (tm.workers[i].asyncCb) {
                tm.workers[i].asyncCb(data).then(()=> {
                    finishTask();
                });
            } else {
                finishTask();
            }
        };
    }

    function processTask(i, task, asyncCb) {
        assert(tm.workers[i].state == "READY");
        tm.workers[i].asyncCb = asyncCb;

        tm.workers[i].state = "WORKING";
        if (task.buff) {
            task.buff = new Uint8Array(task.buff);
            tm.workers[i].worker.postMessage(task, [task.buff.buffer]);
        } else {
            tm.workers[i].worker.postMessage(task);
        }

    }

    for (let i=0; i<concurrency; i++) {

        const worker = new NodeWorker(`(${thread.toString()})(require('worker_threads').parentPort, ${fn.toString()},${S});`, {eval: true});

        worker.on("message", getOnMsg(i));

        tm.workers[i] = {
            state: "READY",
            worker: worker,
            taskPromise: null
        };

    }

    for (let i=0; i<concurrency; i++) {
        initTask.cmd = "INIT";
        initTask.processId = i;
        processTask(i, initTask);
    }

    tm.finish = function() {
        const self = this;
        assert (self.terminatePromise == null);

        self.terminateDeferred = new Deferred();

        for (let i=0; i<concurrency; i++) {
            if (self.workers[i].state == "READY") {
                self.workers[i].worker.postMessage({cmd: "TERMINATE"});
            }
        }

        return self.terminateDeferred.promise;
    };

    tm.addTask = function (task, asyncCb) {
        const self = this;
        assert (!self.waitingTask);
        assert(!self.terminateDeferred);
        const deferral = new Deferred();
        let i;
        for (i=0; i<tm.workers.length; i++) {
            if (self.workers[i].state == "READY") break;
        }
        if (i<tm.workers.length) {
            processTask(i, task, asyncCb);
            deferral.resolve();
        } else {
            self.waitingTask = {
                task: task,
                deferral: deferral,
                asyncCb: asyncCb
            };
        }
        return deferral.promise;
    };

    tm.tryTerminate = function() {
        const self = this;
        if (!self.terminateDeferred) return;
        for (let i=0; i<concurrency; i++) {
            if (self.workers[i].state != "TERMINATED") return;
        }
        self.terminateDeferred.resolve();
    };

    return tm;
}

module.exports = buildTaskManager;