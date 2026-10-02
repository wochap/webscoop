# browser-daemon Specification

## Purpose

Lets many `webscoop run` and `webscoop test` invocations share one warm, headed browser per profile, running concurrently or queued, while at most one run per browser asks the user for help at a time.

## Requirements

### Requirement: Daemon lifecycle
`run` and `test` SHALL execute their recipe in a background daemon. When no daemon answers on the socket, the command SHALL start one detached from its terminal and connect to it. At most one daemon SHALL serve a socket; when two commands start one at the same moment, one daemon SHALL remain and both commands SHALL use it. The socket SHALL be `$WEBSCOOP_HOME/run/daemon.sock` when `WEBSCOOP_HOME` is set, else `$XDG_RUNTIME_DIR/webscoop/daemon.sock`, else `/tmp/webscoop-<uid>/daemon.sock`, and SHALL be accessible only by the user. The daemon SHALL write its log to `daemon.log` in the webscoop state directory. The daemon SHALL exit when it has no browser open and no job.

#### Scenario: First run starts the daemon
- **WHEN** no daemon runs and `webscoop run shop` is executed
- **THEN** a daemon starts, runs the recipe, the command exits with the run's exit code, and the daemon keeps running

#### Scenario: Daemon exits when idle
- **WHEN** `daemon.idleMs` is 60000 and the last job on the last browser ended 60 seconds ago
- **THEN** that browser closes and the daemon exits

#### Scenario: Racing starts
- **WHEN** two `webscoop run` commands start at the same moment with no daemon running
- **THEN** exactly one daemon process remains and both runs complete

### Requirement: Browsers per profile
The daemon SHALL keep at most one browser per profile directory, launched on the first job for that profile, with the profile lock held for as long as the browser is open. Each job SHALL run in its own new tab of that browser and SHALL close its tab, and any popup opened from it, when it ends. A browser SHALL close after it has had no job for `daemon.idleMs` milliseconds (config, default 60000; 0 closes it as soon as its last job ends). The launch settings of a browser are its driver, channel, binary, proxy, timezone, locale, and extra arguments. A job whose launch settings differ from those of its profile's open browser SHALL wait until that browser has no job, then the browser SHALL be closed and relaunched with the job's settings.

#### Scenario: Warm browser reused
- **WHEN** `webscoop run shop` ends and `webscoop run shop --var page=2` starts 10 seconds later
- **THEN** the second run opens a tab in the same browser process and does not launch a new one

#### Scenario: Different profiles run apart
- **WHEN** a job on profile `default` and a job on profile `work` run at the same time
- **THEN** two browser processes are open, one per profile

#### Scenario: Different proxy waits for a relaunch
- **WHEN** a job with proxy `socks5://a:1080` is running on profile `default` and a job on `default` with no proxy is submitted
- **THEN** the second job starts after the first ends, in a relaunched browser without the proxy

### Requirement: Scheduling
Each browser SHALL run at most `daemon.concurrency` jobs at once (config, default 1). Further jobs for that browser SHALL wait in submission order. `run` and `test` SHALL accept `--queue-timeout <ms>`: when the job has not started within that time it SHALL be removed from the queue and the command SHALL exit 1 with a message naming the profile and the number of jobs ahead. Without `--queue-timeout` a job SHALL wait until it starts. While a job waits, the command SHALL print one stderr line saying it is queued and how many jobs are ahead, unless `--quiet` is given.

#### Scenario: Default queue
- **WHEN** `daemon.concurrency` is 1 and three runs on profile `default` are submitted at once
- **THEN** they run one after another in submission order, in one browser

#### Scenario: Parallel runs of one recipe
- **WHEN** `daemon.concurrency` is 3 and `webscoop run bing --var query=cat`, `--var query=dog`, and `--var query=fox` are started at once
- **THEN** the three runs extract at the same time in three tabs and each prints only its own rows

#### Scenario: Queue timeout
- **WHEN** one job is running on profile `default`, `daemon.concurrency` is 1, and `webscoop run shop --queue-timeout 1000` is started and the running job lasts longer than 1 second
- **THEN** the command exits 1 with a message naming `default` and 1 job ahead

### Requirement: Jobs behave like local runs
A job SHALL produce the same rows, stdout, `--out` files, stderr log lines, and exit code as a run without a daemon. A job SHALL use the environment, working directory, config, and recipe files of the command that submitted it, read when the job is submitted. Interrupting the command (SIGINT) or losing its connection SHALL cancel its job, close its tab, and leave other jobs running; the command SHALL exit 1. Recipe write-backs from jobs SHALL be applied one at a time per recipe file.

#### Scenario: Ctrl+C cancels only one job
- **WHEN** two jobs run in one browser and the user presses Ctrl+C in the terminal of the first
- **THEN** the first command exits 1, its tab closes, and the second job continues

#### Scenario: Per-job environment
- **WHEN** a daemon was started from a shell without `WEBSCOOP_LLM_KEY` and a later run is started from a shell that has it
- **THEN** that run's model rung uses the key from its own shell

### Requirement: Version handshake
A command SHALL send its webscoop version and program path when it connects. When they differ from the daemon's, the daemon SHALL refuse new jobs, finish its running and queued jobs, and exit; the command SHALL wait for it to exit, start a new daemon, and submit its job there.

#### Scenario: Upgrade while warm
- **WHEN** webscoop is rebuilt to a new version while a daemon from the old version is idle, and `webscoop run shop` is executed
- **THEN** the old daemon exits and the run is served by a new daemon of the new version

### Requirement: Attention per browser
At most one job per browser SHALL hold the user's attention at a time. When a guard is raised, an `await-user` step starts, or an interactive run asks for a re-pick, the job SHALL wait for attention.
- **After waiting for a guard:** a job that had to wait SHALL, once it gets attention, reload its page, wait for it to settle, and re-check the guard. When the guard no longer matches, it SHALL release attention and continue without asking the user.
- **After waiting for an `await-user` step:** the job SHALL check the step's condition once without reloading, and continue without asking the user when it holds.
- **Otherwise** the job SHALL bring the window that needs the user to the front and emit `attention.needed`, and SHALL keep attention until `attention.resolved`.

While a job waits for attention, its command SHALL print one stderr line naming the run holding attention, unless `--quiet` is given.

#### Scenario: One solve frees the queue
- **WHEN** two runs of `bing` in one browser both hit a captcha, the first gets attention, and the user solves it
- **THEN** the second run reloads, finds no captcha, and continues without an `attention.needed` of its own

#### Scenario: Different site still asks
- **WHEN** a run of `bing` holds attention for a captcha and a run of `shop` in the same browser hits a login guard
- **THEN** the `shop` run gets attention after the `bing` attention resolves, re-checks, and, still blocked, emits `attention.needed`

#### Scenario: Shared login satisfies a waiting await-user
- **WHEN** two runs of `sunat` share a profile, both reach an `await-user` login step, and the user logs in for the first
- **THEN** the second run's condition already holds when it gets attention, and it continues without an `attention.needed` of its own

### Requirement: Answering attention
While a job holds attention it SHALL accept a continue signal, which re-checks the guard or the `await-user` condition at once, and an abort signal, which ends the run with failure reason `aborted`. The signals SHALL come from any of:
- the in-page banner defined by the guards capability;
- when the submitting command's standard error is a terminal, a prompt `Solved? [Y/n/a]` on the controlling terminal, for guards and for `await-user` steps: `Y` or Enter sends continue, `n` keeps waiting without prompting again, `a` sends abort; when a continue finds the guard or the condition still present, the command SHALL say so and prompt again;
- `webscoop attention continue [run-id]` and `webscoop attention abort [run-id]`, which act on the job with that run id, or on the only job holding attention when no id is given, and exit 1 listing the run ids when none or more than one job holds attention and no id is given.

When attention resolves by any path, a pending prompt SHALL be withdrawn. The prompt SHALL be shown even with `--quiet` and SHALL NOT be written to stdout.

#### Scenario: Terminal answer
- **WHEN** a run in a terminal holds attention for a captcha, the user solves it in the browser and presses Enter at `Solved? [Y/n/a]`
- **THEN** the guard is re-checked at once and the run continues

#### Scenario: Answer from a hook
- **WHEN** an `attention.needed` hook shows a notification whose action runs `webscoop attention continue`
- **THEN** the job holding attention re-checks its guard at once

#### Scenario: Pipe keeps the prompt off stdout
- **WHEN** `webscoop run shop | jq .` holds attention in a terminal
- **THEN** the prompt appears on the terminal and stdout carries only rows

#### Scenario: Terminal answer for await-user
- **WHEN** an `await-user` step waits, the user logs in, and presses Enter at `Solved? [Y/n/a]`
- **THEN** the condition is checked at once and the step completes

### Requirement: Exclusive commands
`record`, `edit`, and `bench` SHALL NOT use the daemon and SHALL take the profile lock themselves. When the daemon has a browser open on their profile, they SHALL, on a terminal, print the number of running and queued jobs on it and ask `Stop it? [y/N]`; `y` SHALL cancel those jobs, close that browser, and continue; any other answer SHALL exit 1 without changes. `--force` SHALL skip the question and stop the browser. Without a terminal and without `--force`, they SHALL exit 1 with a message naming the profile. Cancelled jobs SHALL end their commands with exit 1 and a message saying which command stopped them. Jobs submitted for that profile while an exclusive command holds the lock SHALL wait in the queue.

#### Scenario: Record over a busy profile
- **WHEN** 2 jobs run on profile `default` and the user starts `webscoop record https://example.com` on a terminal and answers `y`
- **THEN** both jobs are cancelled, their commands exit 1 naming `record`, the browser closes, and recording starts on `default`

#### Scenario: Unattended edit refuses
- **WHEN** a browser is open on profile `default` and `webscoop edit shop` runs without a terminal and without `--force`
- **THEN** it exits 1 naming `default`, and the jobs keep running

### Requirement: Daemon commands
`webscoop daemon status [--json]` SHALL print whether a daemon runs, its pid and version, and per browser the profile, the browser main process id, the running and queued run ids with their recipes, and the run holding attention; it SHALL exit 0 whether or not a daemon runs. `webscoop daemon stop` SHALL make the daemon refuse new jobs, wait for running and queued jobs to finish, close every browser, and exit; `--force` SHALL cancel the jobs instead of waiting.

#### Scenario: Status while busy
- **WHEN** one job runs and one is queued on profile `default` and `webscoop daemon status --json` is executed
- **THEN** it prints JSON listing the browser for `default` with one running and one queued run id

#### Scenario: Stop with force
- **WHEN** `webscoop daemon stop --force` is executed while jobs run
- **THEN** the jobs' commands exit 1, every browser closes, and the daemon exits
