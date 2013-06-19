# nac

nac is a simple app control and monitoring daemon written in node

nac is multi-server-aware which allows you to use it with parallel control 
tools such as [pssh](http://www.theether.org/pssh/),
[cssh](http://sourceforge.net/projects/clusterssh/),
[fabric](http://docs.fabfile.org/en/1.6/), or, in the future, **rnac**

# how it works

Write a nacfile for your app. The syntax is 
[YAML](http://en.wikipedia.org/wiki/YAML)

```yaml
command: myapp.js
env: 
  NODE_ENV: production
  PORT: 5000
```

Add the nacfile to git, clone the app on your server and run the command

    # nac add myapp ~/projects/myapp/nacfile.yaml
    Added myapp (~/projects/myapp/nacfile.yaml)
    # nac start myapp 

# other configuration options

There are two types of configuration files in nac:

* app configuration (nacfile)
* server daemon configuration (nacd.yaml)

### nacfile

Here is a complete example nacfile:

```yaml
name: myapp
# command to execute. It doesn't have to be a JS file
command: myapp-cluster.js
# working dir relative to the nacfile
cwd: .

# extra arguments to add
args: 
  # long arguments are automatically prefixed with --
  longarg: value
  # one-letter arguments are prefixed with -
  s: shortarg value
  # you can add an explicit prefix if you wish
  --explicit-form: value
  -e: value
  # and you can define a list of additional arguments
  _: [even, more, arguments here]

# environment variables
env: 
  workers: 4
  NODE_ENV: production
  # clustering is best left to the app

# you can add additional scripts which will become available
# as commands for the specific project
scripts: 
  deploy: scripts/deploy.sh
  report: scripts/statusReport.sh

# override options on a per-server-tag basis
servers: 
  two.myapp.com: 
    env: 
      REDIS_SERVER: one.myapp.com
  one.myapp.com:
    env: 
      # even though nac doesnt handle clustering, it
      # can pass clustering configuration via env or args 
      # on a per-server basis
      workers: 6
      REDIS_SERVER: localhost
```

### nacd.yaml

Located in `/etc`, it contains global configuration of the nac daemon.

Example `/etc/nacd.yaml` for the first server:

```yaml
tags: 
    - one.myapp.com
    - one
    - myapp-servers
```

Since this server has the tag "one.myapp.com", it will apply the specified 
config overrides for that tag

# available commands

#### create

    nac create myapp nacfile.yaml

Adds the specified app with its nacfile to the daemon.

The name specified must be unique for that server and user. If the user already
has an app running under that name, on that server, nac will complain.

#### start, stop, restart

    nac [start|stop|restart] myapp

Start/stop/restart the app `myapp` using the command, arguments and 
environment variables specified in the config file. 

#### kill

    nac kill myapp <SIGNAL>

Send the specified named signal to the app's process. Useful for user-defined 
signals such as cluster reloading

#### remove 

    nac remove myapp

Will remove the project and its nacfile from the daemon and stop the app 
process

#### update

    nac update <myapp> [configpath]

Will update the configuration file. If you omit the path, `nacd` will attempt 
to reload the configuration file from the same location as previously 
specified. If you specify the config path, `nacd` will update the apps's 
configuration and update the location of the config file for that app

#### log

    nac log myapp

Show stdout/stderr logs for the project. Logs will be displayed in the format

[iso-date] [stdout|stderr]: content

Arguments:

* --stdout - show just stdout
* --stderr - show just stderr
* --last <N> - show last N lines in log (default 100)
* --past <time> - show just the past days/hours/minutes/seconds e.g. --past 2m
* --duration <time> - show the specified diration (--past required)

### run

    nac run myapp <script> [args]

Run one of the scripts for the project with the specified arguments. Will
display the output of the script.

# environment variables

When running the app or its custom script, `nac` sets the following extra 
environment variables:

* NACFILE - full path to the nacfile 
* NACDIR  - absolute working directory of the app
* NACNAME - the name of the app (e.g. myapp)

# licence

MIT

