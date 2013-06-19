var db = require('../db');
var log = require('./log');

var through = require('through');

var daemonConfig = require('./config');

var appconfOverride = require('../appconf-override');
var opts2args = require('../opts2args');
var duration = require('../duration');


var util = require('util');
var fs = require('fs');
var path = require('path');

var yaml = require('js-yaml');
var async = require('async');
var _ = require('lodash');

var EventEmitter = require('events').EventEmitter;


var app = module.exports = db.define({
    name: 'apps',
    columns: [
        { name: 'id', dataType: 'integer primary key' },
        { name: 'uid', dataType: 'integer' },
        { name: 'name', dataType: 'text' },
        { name: 'nacfile', dataType: 'text' },
        { name: 'active', dataType: 'integer' }
    ]
});


var spawn = require('child_process').spawn;


app.all = function (cb) {
    app.select().all(function (err, apps) {
        if (err) return cb(err);
        if (apps) return async.map(apps, app.construct, cb);
        return cb(null, []);
    });
};

app.construct = function (opts, cb) {
    if (opts.name == 'all')
        return cb(new Error('Name "all" is reserved'));
    fs.readFile(opts.nacfile, function (err, data) {
        try {
            var config = yaml.safeLoad(data.toString(), {
                filename: opts.nacfile
            });
            opts.config = config;
            var app = new App(opts);

            var done = (function (err) {
                if (err) return cb(err);
                if (this.active)
                    return this.start(cb);
                return cb(null, app);
            }.bind(app));

            if (!app.id) app.save(done);
            else done();

        } catch (e) {
            cb(e);
        }
    });
};


util.inherits(App, EventEmitter);

function App(opts) {
    EventEmitter.call(this);
    this.id = opts.id;
    this.uid = opts.uid;
    this.name = opts.name;
    this.active = opts.active;
    this.started = false;
    this.setConfig(opts.nacfile, opts.config);
}

App.prototype.setConfig = function (nacfile, config) {
    this.nacfile = nacfile;
    this.config = appconfOverride(daemonConfig.tags, config);
    this.cwd = path.join(path.dirname(nacfile), config.cwd || '');
    this.logger = log.construct(this.id);

    // set exponential backoff defaults
    var backoff = this.config.backoff = this.config.backoff || {};
    backoff.min = backoff.min || 0.25;
    backoff.max = backoff.max || 120;
    this.respawntime = this.respawntime || backoff.min;

};


App.prototype.save = function (cb) {
    var self = this;
    var fields = {
        uid: this.uid,
        name: this.name,
        nacfile: this.nacfile,
        active: this.active
    };

    if (!this.id)
        app.select(app.id).where({uid: self.uid, name: self.name})
            .get(function (err, res) {
                if (res)
                    return cb(new Error("App already exists"));
                app.insert(fields).exec(function (err, res) {
                    if (err) return cb(err);
                    app.where({uid: self.uid, name: self.name})
                        .get(function (err, app) {
                            if (err) return cb && cb(err);
                            self.id = app.id;
                            self.logger.appId = self.id;
                            return cb && cb(null, self);
                        });
                });
            });
    else app.where({id: this.id}).update(fields)
        .exec(function (err, res) {
            return cb && cb(err, self);
        });
};

App.prototype._getEnv = function () {
    return _.merge({}, process.env, this.config.env, {
        NACFILE: this.nacfile,
        NACDIR: this.cwd,
        NACNAME: this.name
    });
};

App.prototype._runProcess = function (done) {
    this.started = Date.now();


    var args = opts2args(this.config.args);

    var proc = this.process = spawn(
        this.config.command, args, {
            env: this._getEnv(),
            cwd: this.cwd,
            uid: this.uid,
            gid: this.uid
        });

    var spawnTimer = setTimeout(function () {
        spawnTimer = null;
        done(null)
    }, 100);
    var self = this;
    proc.on('error', function (e) {
        if (spawnTimer) {
            clearTimeout(spawnTimer)
            spawnTimer = null;
            done(e);
        }
        self._onExit();
    });
    proc.on('exit', this._onExit.bind(this));
    proc.stdout.pipe(this.logger.stream('stdout'));
    proc.stderr.pipe(this.logger.stream('stderr'));

    return proc;
};

App.prototype.start = function (cb) {
    var self = this;
    if (self.started)
        return cb(new Error("App already started"));
    self.active = true;
    self.started = Date.now();
    self.emit('before_start');

    self.save(function (err) {
        if (err) {
            self.logger.log('start', "application failed to save: " + err.message);
            return cb(err);
        }
        self._runProcess(function (err) {
            if (err) {
                self.logger.log('start', "application failed to start: " + err.message);
                return cb(err);
            }
            self.logger.log('start', "application started");
            self.emit('start');
            cb(null, this);
        });
    });


};

App.prototype._onExit = function (code, signal) {

    if (this.restarting || this.active) {
        // didnt die by signal or died while restarting.
        this.restarting = false;

        var backoff = this.backoff;
        var timeout = Math.min(this.respawntime, backoff.max);
        var realTimeout = timeout * 1000 - (Date.now() - this.started);
        realTimeout = Math.max(realTimeout, 1); // min 1ms

        if (!this.restarting)
            this.logger.log('respawn', 'process died with exit code ' + code
                + ', respawning in ' + timeout.toFixed(1) + 's');

        this.emit('respawn', {
            restarting: this.restarting,
            code: code
        });

        setTimeout(this._runProcess.bind(this), realTimeout);

        this.respawntime *= 2;
        setTimeout(function () {
            this.respawntime = this.respawntime / 2;
        }.bind(this), backoff.max);

    } else {

        this.logger.log('exit', 'process died with code ' + code + ' after receiving ' + signal);
        this.emit('exit', {code: code, signal: signal});
        this.started = null;
    }
};

App.prototype.stop = function stop(cb) {
    this.active = false;
    this.save(function (err) {
        if (err) return cb(err);
        this.process.kill();
        cb(null, this);
    }.bind(this));


};

App.prototype.restart = function restart(cb) {
    this.restarting = true;
    this.process.kill();
    cb(null, this);
};

App.prototype.kill = function kill(signal, cb) {
    this.process.kill(signal);
    return cb(null, this);
};

App.prototype.run = function run(script) {
    var args = [].slice.call(arguments, 1);
    var cb = args[args.length - 1];
    args = opts2args.flatten(args.slice(0, args.length - 1))

    if (!this.config.scripts || !this.config.scripts[script])
        return cb && cb(new Error('Unknown script: ' + script));

    var scriptpath = path.join(
        path.dirname(this.nacfile),
        this.config.scripts[script]);

    var scriptwd = path.dirname(scriptpath);

    this.logger.log("script", "--- running " + script + ' ' + args.join(' '));

    var scriptp = spawn(scriptpath, args, {
        env: this._getEnv(),
        cwd: scriptwd,
        uid: this.uid,
        gid: this.uid
    });

    var output = through();

    scriptp.stdout.pipe(output);
    scriptp.stderr.pipe(output);

    scriptp.on('error', function (e) {
        var msg = script + args.join(' ') + " > error " + e.message;
        this.logger.log("script", msg);
    }.bind(this));

    scriptp.on('exit', function (code) {
        setImmediate(this.logger.log.bind(this.logger, "script", "--- exited " + script + ' ' + args.join(' ')
            + "with error code " + code));
    }.bind(this));

    var clientStream = through();

    clientStream.pause();

    output.pipe(clientStream);
    output.pipe(this.logger.stream('script'));


    var dataend = function (datacb, endcb) {
        clientStream.on('data', function(d) {
            datacb(d.toString());
        });
        clientStream.on('end', endcb);
        clientStream.resume();
    };


    return cb && cb(null, {
        appname: this.name,
        script: script,
        file: this.config.scripts[script],
        pipe: dataend
    });

};

App.prototype.update = function (nacfile, cb) {

    if (!nacfile) nacfile = this.nacfile;
    fs.readFile(nacfile, function (err, data) {
        var config = yaml.safeLoad(data.toString(), {
            filename: nacfile
        });
        this.setConfig(nacfile, config);
        opts.config = config;
        cb(null);
    }.bind(this));

};

App.prototype.uptime = function (cb) {
    if (!this.started)
        if (cb) return cb(null, 'inactive')
        else return 'inactive';

    var uptime = duration.stringify(Date.now() - this.started);
    if (cb) cb(null, uptime);
    else return uptime;
};

App.prototype.status = function (cb) {
    return {
        name: this.name,
        nacfile: this.nacfile,
        active: this.active,
        uptime: this.uptime(),
        pid: this.process ? this.process.pid : '-'
    };
};


App.prototype.logs = function (opt, cb) {
    if (!cb) {
        cb = opt;
        opt = {};
    }
    this.logger.lines(opt, cb);
};

