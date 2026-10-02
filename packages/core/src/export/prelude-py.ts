/**
 * Runtime of an exported Python script, section by section the same as
 * `TS_PRELUDE`, on the Playwright sync API. The renderer emits the recipe
 * constants after it.
 *
 * URL resolution and query parameters run in the page (`new URL`), so they
 * follow the same WHATWG rules as the runner; the other conversions are
 * plain Python.
 *
 * Kept free of backticks and template placeholders so it can live in a raw
 * string literal.
 */
export const PY_PRELUDE = String.raw`import argparse
import errno
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

# ---------------------------------------------------------------------------
# Exit codes, failures, and secret redaction (cli exit.ts, redact.ts)
# ---------------------------------------------------------------------------

EXIT_OK = 0
# Bad arguments, a missing variable, a timeout, a reactive flow loop, lost pagination, or any other error.
EXIT_ERROR = 1
# An await-user step was not completed in time.
EXIT_PAUSED = 2
# A required field, the item container, or a required step matched nothing.
EXIT_UNRESOLVED = 3


class Failure(Exception):
    def __init__(self, message, code, keep_rows=None):
        super().__init__(message)
        self.code = code
        # Print the rows of the pages done before it, as the CLI does for a timed out wait and lost pagination.
        self.keep_rows = code == EXIT_PAUSED if keep_rows is None else keep_rows


# Values of the secret variables, longest first, masked in everything the script prints.
SECRETS = []


def redact(text):
    for secret in SECRETS:
        text = text.replace(secret, "***")
    return text


def log(message):
    print(redact(RECIPE_NAME + ": " + message), file=sys.stderr, flush=True)


def now_ms():
    return time.monotonic() * 1000


def sleep_ms(ms):
    time.sleep(ms / 1000)


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


class ArgumentParser(argparse.ArgumentParser):
    """Exit 1 on bad arguments, like the CLI, instead of argparse's 2."""

    def error(self, message):
        self.print_usage(sys.stderr)
        log(message)
        sys.exit(EXIT_ERROR)


def parse_pages(value):
    if value == "all":
        return "all"
    if not re.fullmatch(r"[0-9]+", value) or int(value) < 1:
        raise argparse.ArgumentTypeError('invalid --pages "' + value + '", expected "all" or a positive integer')
    return int(value)


def parse_await_timeout(value):
    if not re.fullmatch(r"[0-9]+", value):
        raise argparse.ArgumentTypeError('invalid --await-timeout "' + value + '", expected milliseconds')
    return int(value)


def expand_path(path):
    """A path as the CLI reads it: ~ is the home directory, relative paths start at the working directory."""
    return os.path.abspath(os.path.expanduser(path))


def parse_args(argv):
    parser = ArgumentParser(
        description="Run the exported webscoop recipe " + RECIPE_NAME + " and print its rows as JSON.",
        epilog="exit codes: 0 success, 1 error, 2 an await-user step timed out, 3 a required field or step matched no element",
    )
    parser.add_argument("--var", dest="sources", action="append", default=[], metavar="NAME=VALUE", type=lambda v: ("--var", v),
                        help="set a recipe variable (repeatable); WEBSCOOP_VAR_<NAME> works too")
    parser.add_argument("--var-file", dest="sources", action="append", metavar="NAME=PATH", type=lambda v: ("--var-file", v),
                        help="set a variable to a file's content, one trailing newline removed (repeatable)")
    parser.add_argument("--var-command", dest="sources", action="append", metavar="NAME=CMD", type=lambda v: ("--var-command", v),
                        help="set a variable to the trimmed output of a shell command (repeatable)")
    parser.add_argument("--jsonl", action="store_true", help="print one JSON object per line instead of a JSON array")
    parser.add_argument("--out", metavar="PATH",
                        help="write the rows to a file instead of stdout; a directory (existing, or ending with a separator)"
                        " gets one <table>.json or <table>.jsonl per table")
    parser.add_argument("--table", metavar="NAME", help="print only this table, as a plain array (or plain JSONL rows)")
    parser.add_argument("--pages", type=parse_pages, metavar="1|N|all", help="pages to walk, replacing the recipe limit")
    parser.add_argument("--await-timeout", dest="await_timeout", type=parse_await_timeout, default=DEFAULT_AWAIT_TIMEOUT_MS, metavar="MS",
                        help="how long an await-user step waits for you (default " + str(DEFAULT_AWAIT_TIMEOUT_MS) + ")")
    parser.add_argument("--headless", dest="headless", action="store_true", default=DEFAULT_HEADLESS,
                        help="run the browser without a window")
    parser.add_argument("--headed", dest="headless", action="store_false", help="show the browser window")
    parser.add_argument("--profile", metavar="DIR", help="browser profile directory to keep (default: a temporary one)")
    opts = parser.parse_args(argv)
    sources = {}
    expected = {"--var": "value", "--var-file": "PATH", "--var-command": "CMD"}
    for flag, pair in opts.sources:
        at = pair.find("=")
        if at <= 0:
            raise Failure("invalid " + flag + ' "' + pair + '", expected name=' + expected[flag], EXIT_ERROR)
        name, rest = pair[:at], pair[at + 1:]
        if name in sources:
            raise Failure('variable "' + name + '" is given more than once on the command line; pass one of --var, --var-file, --var-command', EXIT_ERROR)
        sources[name] = (flag, expand_path(rest) if flag == "--var-file" else rest)
    opts.vars = sources
    names = [table["name"] for table in TABLES]
    if opts.table is not None and opts.table not in names:
        raise Failure('recipe "' + RECIPE_NAME + '" has no table "' + opts.table + '" (tables: ' + ", ".join(names) + ")", EXIT_ERROR)
    opts.out_dir = bool(opts.out) and (opts.out.endswith("/") or opts.out.endswith(os.sep) or os.path.isdir(opts.out))
    return opts


# ---------------------------------------------------------------------------
# Variables and templates (cli vars.ts, core template.ts)
# ---------------------------------------------------------------------------

VARIABLE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def env_name(name):
    return "WEBSCOOP_VAR_" + name.upper()


def read_source(name, source):
    """A command line source's value; failures never hold a file's content or a command's output."""
    flag, value = source
    if flag == "--var":
        return value
    if flag == "--var-file":
        try:
            with open(value, encoding="utf-8") as file:
                return re.sub(r"\r?\n$", "", file.read(), count=1)
        except OSError as error:
            code = errno.errorcode.get(error.errno, "error") if error.errno else "error"
            raise Failure('variable "' + name + '": cannot read the command line file source ' + value + " (" + code + ")", EXIT_ERROR)
    try:
        result = subprocess.run(["/bin/sh", "-c", value], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=VAR_COMMAND_TIMEOUT_MS / 1000)
    except subprocess.TimeoutExpired:
        raise Failure('variable "' + name + '": the command line command source failed: timed out after '
                      + str(VAR_COMMAND_TIMEOUT_MS // 1000) + " seconds", EXIT_ERROR)
    except OSError:
        raise Failure('variable "' + name + '": the command line command source failed: cannot start', EXIT_ERROR)
    if result.returncode != 0:
        why = "exit status " + str(result.returncode) if result.returncode > 0 else "killed by signal " + str(-result.returncode)
        raise Failure('variable "' + name + '": the command line command source failed: ' + why, EXIT_ERROR)
    return result.stdout.decode("utf-8").strip()


def given_value(given, name):
    """A value the user gave: a command line source first, then the environment."""
    if name in given:
        return given[name]
    return os.environ.get(env_name(name))


def resolve_vars(given):
    """Every variable value for the run: given values first, recipe defaults second. Secret values are masked from here on."""
    values = dict(given)
    missing = []
    for var in VARS:
        value = given_value(given, var["name"])
        if value is None:
            value = var["default"]
        if value is not None:
            values[var["name"]] = value
        elif var["required"]:
            missing.append(var["name"])
    SECRETS[:] = sorted((values[v["name"]] for v in VARS if v["secret"] and values.get(v["name"])), key=len, reverse=True)
    if missing:
        first = missing[0]
        raise Failure(
            "missing value for variable" + ("s " if len(missing) > 1 else " ") + ", ".join(missing)
            + "; pass --var " + first + "=<value> or set " + env_name(first),
            EXIT_ERROR,
        )
    return values


def encode_uri_component(value):
    return quote(value, safe="!'()*-._~")


def fill_template(template, values):
    """Fill a URL template: every value URL-encoded."""
    return VARIABLE.sub(lambda m: encode_uri_component(values.get(m.group(1), "")), template)


def fill_text(template, values):
    """Fill a typed value: inserted as it is."""
    return VARIABLE.sub(lambda m: values.get(m.group(1), ""), template)


def path_files(action, values):
    """The files of a fill whose value is one path variable alone: split on ":", each checked readable before the step acts."""
    if action["path"] is None:
        return None
    files = []
    for path in [p.strip() for p in fill_text(action["text"], values).split(":")]:
        if path == "":
            continue
        absolute = expand_path(path)
        if not (os.path.isfile(absolute) and os.access(absolute, os.R_OK)):
            raise Failure('variable "' + action["path"] + '": no readable file at ' + path, EXIT_ERROR)
        files.append(absolute)
    return files


def page_start(given):
    """First value of the page variable: the user's value when given, else the recipe's start."""
    param = PAGINATION["param"]
    if not param:
        return 0
    value = given_value(given, param["name"])
    if value is None:
        return param["start"]
    if not re.fullmatch(r"-?[0-9]+", value.strip()):
        raise Failure("page variable " + param["name"] + ' must be an integer, got "' + value + '"', EXIT_ERROR)
    return int(value)


def url_for(page, values, start, number):
    """URL of a page: for kind url the page variable is filled in, or set as a query parameter when the template lacks it."""
    param = PAGINATION["param"]
    if PAGINATION["kind"] != "url":
        return fill_template(URL_TEMPLATE, values)
    if not param:
        raise Failure("pagination kind url needs pagination.param", EXIT_ERROR)
    value = str(start + param["step"] * (number - 1))
    filled = fill_template(URL_TEMPLATE, {**values, param["name"]: value})
    if PAGINATION["paramInTemplate"] or page is None:
        return filled
    return page.evaluate(PAGE_JS["setQueryParam"], [filled, param["name"], value])


def same_url(page, a, b):
    if a == b:
        return True
    try:
        return page.evaluate("([a, b]) => new URL(a).href === new URL(b).href", [a, b])
    except PlaywrightError:
        return False


# ---------------------------------------------------------------------------
# Value conversion (core convert.ts)
# ---------------------------------------------------------------------------

# JavaScript's whitespace set, for \s and trim().
WHITESPACE_CHARS = "".join(
    chr(c) for c in (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)
)
WHITESPACE = re.compile("[" + re.escape(WHITESPACE_CHARS) + "]+")


def js_trim(raw):
    return raw.strip(WHITESPACE_CHARS)


def collapse_whitespace(raw):
    return js_trim(WHITESPACE.sub(" ", raw))


def js_number(value):
    """A float as JavaScript prints it: integral values without a fraction."""
    return int(value) if value.is_integer() and abs(value) < 1e21 else value


NUMBER = re.compile(r"-?[0-9][0-9,]*(?:\.[0-9]+)?|-?\.[0-9]+")


def parse_number(raw):
    """First numeric token in the text, with thousands separators removed."""
    match = NUMBER.search(raw)
    if not match:
        return None
    value = float(match.group(0).replace(",", ""))
    return js_number(value) if math.isfinite(value) else None


def resolve_url(page, raw, page_url):
    trimmed = js_trim(raw)
    if trimmed == "":
        return None
    return page.evaluate(PAGE_JS["resolveUrl"], [trimmed, page_url])


MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def month_index(name):
    short = name[:3].lower()
    return MONTHS.index(short) + 1 if short in MONTHS else None


def iso_date(year, month, day):
    # Date.UTC maps years 0 to 99 to 1900 to 1999, so the runner rejects them.
    if year < 100:
        return None
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


ISO_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
ISO_DATE_TIME = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|([+-])([0-9]{2}):?([0-9]{2}))?"
)
US_DATE = re.compile(r"([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})")
DOTTED_DATE = re.compile(r"([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})")
MONTH_FIRST = re.compile(r"([A-Za-z]{3,9})\.? ([0-9]{1,2}),? ([0-9]{4})")
DAY_FIRST = re.compile(r"([0-9]{1,2}) ([A-Za-z]{3,9})\.? ([0-9]{4})")


def iso_date_time(m):
    """A date-time as JavaScript's Date parses it: no offset means local time, the fraction is cut to milliseconds."""
    year, month, day, hour, minute = (int(m.group(i)) for i in range(1, 6))
    second = int(m.group(6) or 0)
    ms = int((m.group(7) or "").ljust(3, "0")[:3])
    if not (1 <= month <= 12 and 1 <= day <= 31 and hour <= 24 and minute <= 59 and second <= 59):
        return None
    if hour == 24 and (minute or second or ms):
        return None
    try:
        moment = datetime(year, month, 1) + timedelta(days=day - 1, hours=hour, minutes=minute, seconds=second, milliseconds=ms)
        zone = m.group(8)
        if zone is None:
            moment = moment.astimezone(timezone.utc)
        else:
            offset = timedelta(0)
            if zone != "Z":
                offset = timedelta(hours=int(m.group(10)), minutes=int(m.group(11)))
                if m.group(9) == "-":
                    offset = -offset
            moment = moment.replace(tzinfo=timezone(offset)).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + "%03d" % (moment.microsecond // 1000) + "Z"


def parse_date(raw):
    """ISO 8601 for: ISO date or date-time, MM/DD/YYYY, DD.MM.YYYY, Month D, YYYY, D Month YYYY. Else None."""
    text = collapse_whitespace(raw)
    m = ISO_DATE.fullmatch(text)
    if m:
        return iso_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = ISO_DATE_TIME.fullmatch(text)
    if m:
        return iso_date_time(m)
    m = US_DATE.fullmatch(text)
    if m:
        return iso_date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
    m = DOTTED_DATE.fullmatch(text)
    if m:
        return iso_date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    m = MONTH_FIRST.fullmatch(text)
    if m:
        month = month_index(m.group(1))
        return None if month is None else iso_date(int(m.group(3)), month, int(m.group(2)))
    m = DAY_FIRST.fullmatch(text)
    if m:
        month = month_index(m.group(2))
        return None if month is None else iso_date(int(m.group(3)), month, int(m.group(1)))
    return None


def convert_value(page, field_type, raw, page_url):
    if field_type == "text":
        return collapse_whitespace(raw)
    if field_type == "number":
        return parse_number(raw)
    if field_type in ("url", "image"):
        return resolve_url(page, raw, page_url)
    if field_type == "date":
        parsed = parse_date(raw)
        return parsed if parsed is not None else collapse_whitespace(raw)
    return js_trim(raw)


# ---------------------------------------------------------------------------
# Browser windows (browser playwright-browser.ts, core flows/windows.ts)
# ---------------------------------------------------------------------------

# Launch flags that keep Chromium from advertising automation.
STEALTH_ARGS = ["--disable-blink-features=AutomationControlled"]
IGNORED_DEFAULT_ARGS = ["--enable-automation"]


class Unresolved(Exception):
    """A step's element showed no option or opened no file chooser: the step found no element."""


class Session:
    """One browser window: navigation, settling, and the actions steps take."""

    def __init__(self, page):
        self.page = page
        # Main frame navigations so far, so settling can tell whether an action navigated.
        self.navigations = 0
        # Navigations counted when the last action started.
        self.navigations_before = 0
        page.on("framenavigated", self._on_navigated)

    def _on_navigated(self, frame):
        if frame == self.page.main_frame:
            self.navigations += 1

    def is_closed(self):
        return self.page.is_closed()

    def goto(self, url):
        """Load the URL; network idle is only a short grace, since some pages never stop requesting."""
        deadline = now_ms() + NAVIGATION_TIMEOUT_MS
        try:
            self.page.goto(url, wait_until="load", timeout=NAVIGATION_TIMEOUT_MS)
        except PlaywrightTimeoutError:
            raise Failure("navigation to " + url + " timed out after " + str(NAVIGATION_TIMEOUT_MS) + " ms", EXIT_ERROR)
        try:
            self.page.wait_for_load_state("networkidle", timeout=max(1, min(SETTLE_IDLE_MS, deadline - now_ms())))
        except PlaywrightError:
            pass
        return self.page.url

    def mark(self):
        """Call right before an action, so settle can tell whether it navigated."""
        self.navigations_before = self.navigations
        return self.page.url

    def settle(self, previous_url):
        """
        After an action: when it navigated (now or within a short grace period),
        wait for load and network idle; otherwise wait briefly for network idle.
        """
        page = self.page
        deadline = now_ms() + NAVIGATION_TIMEOUT_MS

        def left():
            return max(1, deadline - now_ms())

        def navigated():
            return self.navigations != self.navigations_before or page.url != previous_url

        try:
            if not navigated():
                try:
                    page.wait_for_event("framenavigated", predicate=lambda frame: frame == page.main_frame,
                                        timeout=min(SETTLE_GRACE_MS, left()))
                except PlaywrightError:
                    pass
            if navigated():
                page.wait_for_load_state("load", timeout=left())
                page.wait_for_load_state("networkidle", timeout=left())
            else:
                try:
                    page.wait_for_load_state("networkidle", timeout=min(SETTLE_IDLE_MS, left()))
                except PlaywrightError:
                    pass
            return page.url
        except PlaywrightTimeoutError:
            raise Failure("waiting for " + page.url + " to load timed out after " + str(NAVIGATION_TIMEOUT_MS) + " ms", EXIT_ERROR)

    def click(self, target):
        self.mark()
        target.scroll_into_view_if_needed()
        target.click()

    def press(self, key, target):
        self.mark()
        if target is not None:
            target.press(key)
        else:
            self.page.keyboard.press(key)

    def fill(self, target, value, files):
        """
        Set an element by its fill kind, as the runner's browser adapter does:
        files, a file chooser, checkbox, switch, or radio, select options,
        a combobox option, one-character boxes, or typed text.
        """
        self.mark()
        kind = target.evaluate(PAGE_JS["classifyFill"])
        if kind == "file":
            target.set_input_files(files if files is not None else [p for p in value.split(":") if p])
            return
        if files is not None:
            self.choose_files(target, files)
        elif kind in ("toggle", "radio"):
            self.set_checked(target, kind, value)
        elif kind == "select":
            self.select_options(target, value)
        elif kind == "combobox":
            self.fill_combobox(target, value)
        elif kind == "otp" and len(value) > 1:
            self.type_keys(target, value)
        else:
            self.fill_text(target, value)

    def choose_files(self, target, files):
        """Click the element and hand the files to the chooser it opens."""
        try:
            with self.page.expect_file_chooser(timeout=FILE_CHOOSER_TIMEOUT_MS) as chooser:
                self.click(target)
        except PlaywrightTimeoutError:
            raise Unresolved("the element opened no file chooser within " + str(FILE_CHOOSER_TIMEOUT_MS // 1000) + " seconds")
        chooser.value.set_files(files)

    def set_checked(self, target, kind, value):
        """Click a checkbox, switch, or radio only when its checked state differs from true or false."""
        wanted = value.strip().lower()
        if wanted not in ("true", "false"):
            raise ValueError("a checkbox, switch, or radio takes true or false, not " + json.dumps(value, ensure_ascii=False))
        if kind == "radio" and wanted == "false":
            raise ValueError("a radio cannot be set to false; fill the radio to choose instead")
        if target.evaluate(PAGE_JS["isChecked"]) != (wanted == "true"):
            self.click(target)

    def select_options(self, target, value):
        """Choose the option whose value or visible label equals the value; for a multiple select, each line's option."""
        found = target.evaluate(PAGE_JS["selectValues"], value)
        if "missing" in found:
            raise ValueError("no option " + json.dumps(found["missing"], ensure_ascii=False))
        target.select_option(value=found["values"])

    def fill_combobox(self, target, value):
        """Type into a combobox, then click the visible option whose accessible name is the value."""
        if target.evaluate(PAGE_JS["isEditable"]):
            self.fill_text(target, value)
        else:
            self.click(target)
            self.page.keyboard.type(value)
        handle = target.element_handle()
        frame = (handle.owner_frame() if handle else None) or self.page.main_frame
        if handle:
            handle.dispose()
        option = frame.get_by_role("option", name=value, exact=True).locator("visible=true").first
        try:
            option.wait_for(state="visible", timeout=NAVIGATION_TIMEOUT_MS)
        except PlaywrightTimeoutError:
            raise Unresolved("the combobox showed no option " + json.dumps(value, ensure_ascii=False) + " within " + str(NAVIGATION_TIMEOUT_MS) + " ms")
        option.click()

    def type_keys(self, target, value):
        """Focus the first box and press each character, so the page moves focus from box to box."""
        target.click()
        target.fill("")
        self.page.keyboard.type(value, delay=20)

    def fill_text(self, target, value):
        """Clear and type; when the value read back still differs, type key by key."""
        target.fill(value)
        if target.evaluate(PAGE_JS["readBack"]) == value:
            return
        target.fill("")
        target.press_sequentially(value, delay=10)

    def scroll_to_bottom(self):
        self.mark()
        self.page.evaluate(PAGE_JS["scrollToBottom"])


class Windows:
    """The windows of the run: the main window, where extraction happens, and the popups opened since, in the order they opened."""

    def __init__(self, context, main):
        self.main = main
        self.popups = []
        self.seq = 0
        context.on("page", self._on_page)

    def _on_page(self, page):
        if page != self.main.page:
            self.seq += 1
            self.popups.append((self.seq, Session(page)))

    def mark(self):
        """A mark for newest_since: popups opened after it are newer."""
        return self.seq

    def open(self):
        """The main window and every popup still open, oldest popup first."""
        return [self.main] + [session for _, session in self.popups if not session.is_closed()]

    def newest_since(self, mark):
        """The newest popup opened after the mark, or None when none did or it has closed."""
        newer = [session for seq, session in self.popups if seq > mark]
        return newer[-1] if newer and not newer[-1].is_closed() else None

    def opened_since(self, mark):
        """Whether any popup opened after the mark, open or closed by now."""
        return any(seq > mark for seq, _ in self.popups)

    def wait_for_popup(self, mark):
        """Wait up to the navigation timeout for a popup opened after the mark."""
        deadline = now_ms() + NAVIGATION_TIMEOUT_MS
        while True:
            if self.opened_since(mark):
                return self.newest_since(mark)
            if now_ms() >= deadline:
                return None
            # A Playwright call lets the page events in.
            self.main.page.wait_for_timeout(50)


# ---------------------------------------------------------------------------
# Selectors and frames (browser locate, core resolveFirst, extract resolveFrame)
# ---------------------------------------------------------------------------


def role_name(name):
    """A role name as a pattern that ignores whitespace, like the TypeScript runner."""
    chars = [re.escape(ch) for ch in re.sub(r"\s+", "", name)]
    return re.compile(r"^\s*" + r"\s*".join(chars) + r"\s*$")


def locate(root, selector):
    """A locator in a window, an element, or an iframe's document."""
    strategy, value = selector["strategy"], selector["value"]
    if strategy == "role":
        role, bar, name = value.partition("|")
        return root.get_by_role(role, name=role_name(name)) if bar else root.get_by_role(role)
    if strategy == "testid":
        return root.get_by_test_id(value)
    if strategy == "id":
        return root.locator("css=[id=" + json.dumps(value, ensure_ascii=False) + "]")
    if strategy == "text":
        return root.get_by_text(value, exact=True)
    if strategy in ("css", "class"):
        return root.locator("css=" + value)
    return root.locator("xpath=" + value)


class Found:
    def __init__(self, index, locator, count):
        # Position of the candidate that matched.
        self.index = index
        self.locator = locator
        self.count = count


def resolve_first(root, selectors):
    """Try candidates in stored order; the first with at least one match wins."""
    for index, selector in enumerate(selectors):
        locator = locate(root, selector)
        count = locator.count()
        if count > 0:
            return Found(index, locator, count)
    return None


def frame_root(page, selectors, timeout_ms):
    """
    Resolve an iframe in the top document and wait for its document: (root to
    resolve inside, candidates from the one that matched on). None when it is
    missing, not a same-origin iframe, or its document does not load.
    """
    found = resolve_first(page, selectors)
    if not found:
        return None
    element = found.locator.nth(0)
    try:
        if not element.evaluate(PAGE_JS["frameReachable"]):
            return None
        handle = element.element_handle(timeout=timeout_ms)
        content = handle.content_frame() if handle else None
        if handle:
            handle.dispose()
        if not content:
            return None
        content.wait_for_load_state("load", timeout=timeout_ms)
    except PlaywrightError:
        return None
    return element.content_frame, selectors[found.index:]


def kept_containers(base, found, exclude):
    """Item containers the candidates found, minus those an exclusion candidate matches anywhere in the base document."""
    containers = [found.locator.nth(i) for i in range(found.count)]
    if not exclude:
        return containers
    excluded = []
    for selector in exclude:
        excluded.extend(locate(base, selector).element_handles())
    if not excluded:
        return containers
    try:
        drop = found.locator.evaluate_all(PAGE_JS["excludedMask"], excluded)
        return [c for c, dropped in zip(containers, drop) if not dropped]
    finally:
        for handle in excluded:
            handle.dispose()


def target_present(session, target):
    """Whether a target resolves to at least one element in a window, with its stored candidates only. A closed window holds nothing."""
    if session.is_closed():
        return False
    try:
        root = session.page
        if target["frame"]:
            frame = frame_root(session.page, target["frame"], 1000)
            if not frame:
                return False
            root = frame[0]
        return resolve_first(root, target["selectors"]) is not None
    except PlaywrightError:
        # The window is mid-navigation or closing.
        return False


# ---------------------------------------------------------------------------
# Step targets (core flows/replay.ts)
# ---------------------------------------------------------------------------


def find_step_target(session, step, cache):
    """
    Find a step's target: the selectors an earlier run of the step settled on
    first, else the stored candidates. A wait step looks until the timeout. A
    framed target resolves inside its iframe, which is found first. Returns
    (locator or None, why it was not found).
    """
    key = step["flow"] + ":" + str(step["index"])
    cached = cache.get(key)
    target = step["target"]
    root = session.page
    frame_selectors = None
    if target["frame"]:
        frame = frame_root(session.page, cached["frame"], NAVIGATION_TIMEOUT_MS) if cached and cached["frame"] else None
        frame = frame or frame_root(session.page, target["frame"], NAVIGATION_TIMEOUT_MS)
        if not frame:
            return None, "found no element: the frame did not resolve"
        root, frame_selectors = frame
    if cached:
        hit = resolve_first(root, cached["selectors"])
        if hit:
            return hit.locator.nth(0), ""
    waiting = step["action"]["kind"] == "wait-for"
    if waiting:
        deadline = now_ms() + NAVIGATION_TIMEOUT_MS
        while True:
            hit = resolve_first(root, cached["selectors"] if cached else target["selectors"])
            if hit:
                return hit.locator.nth(0), ""
            if now_ms() >= deadline:
                break
            sleep_ms(min(WAIT_POLL_MS, max(0, deadline - now_ms())))
    found = resolve_first(root, target["selectors"])
    if not found:
        return None, "found no element within " + str(NAVIGATION_TIMEOUT_MS) + " ms" if waiting else "found no element"
    cache[key] = {"selectors": target["selectors"][found.index:], "frame": frame_selectors}
    return found.locator.nth(0), ""


# ---------------------------------------------------------------------------
# Extraction and the missing field policy (core extract.ts)
# ---------------------------------------------------------------------------


def read_value(page, field, element, page_url):
    if field["read"] == "attr":
        raw = element.get_attribute(field["attr"]) or ""
    elif field["read"] == "html":
        raw = element.inner_html()
    else:
        raw = element.text_content() or ""
    return convert_value(page, field["type"], raw, page_url)


def hover_first(element):
    """Move the real mouse over the element: at its center, then just inside its top-left corner when the center is covered, then give up. After a hover, wait one animation frame so the page's handlers have run."""
    for options in ({"timeout": 1000}, {"position": {"x": 2, "y": 2}, "timeout": 500}):
        try:
            element.hover(**options)
        except Exception:
            continue
        try:
            element.evaluate(PAGE_JS["nextFrame"])
        except Exception:
            pass
        return


def field_value(page, field, element, page_url):
    """A field's value on one row and whether it was found: an element matched and its value is neither None nor empty. Empty values yield None."""
    if element is not None and field.get("hover"):
        hover_first(element)
    value = read_value(page, field, element, page_url) if element is not None else None
    return (None, False) if value is None or value == "" else (value, True)


def settle_selectors(selectors, scopes):
    """First candidate, in stored order, that matches in any of the scopes; its selectors from there on."""
    for index, selector in enumerate(selectors):
        for scope in scopes:
            if locate(scope, selector).count() > 0:
                return selectors[index:]
    return None


def list_parent(base, item, resolved):
    """
    Where item containers are searched: inside the list parent's first match,
    else the base. Returns (root, settled selectors, missing).
    """
    within = item.get("within")
    if not within:
        return base, None, False
    selectors = resolved["within"] if resolved else within
    found = resolve_first(base, selectors) if selectors else None
    if not found:
        return base, None, True
    return found.locator.nth(0), (resolved["within"] if resolved else within[found.index:]), False


def table_base(page, table, resolved):
    """A table's base: (the window or its iframe's document, settled frame selectors). None when the iframe does not resolve or load."""
    if not table["frame"]:
        return page, None
    return frame_root(page, (resolved or {}).get("frame") or table["frame"], NAVIGATION_TIMEOUT_MS)


def count_items(page, table, resolved):
    """How many containers of a table the window holds now, with the selectors an earlier extraction settled on. A table without an item block, or no table, counts one."""
    if not table or not table["item"]:
        return 1
    if not resolved or not resolved["item"]:
        return 0
    at = table_base(page, table, resolved)
    if not at:
        return 0
    base = at[0]
    root, _, missing = list_parent(base, table["item"], resolved)
    if missing:
        return 0
    found = resolve_first(root, resolved["item"])
    return len(kept_containers(base, found, table["item"]["exclude"])) if found else 0


def extract_table(page, table, page_number, page_url, resolved, from_index):
    """
    Every row of one table on the current page, from item container
    from_index on (a page that grew). Returns a dict: the table name, rows
    kept after dropping those with a missing required field, container_count
    and first_row before dropping, the dropped_fields that caused a drop,
    missing_required, warnings, and the resolved selectors later extractions
    reuse (None for a table that matched nothing, so a later one resolves it
    afresh).
    """
    prefix = 'table "' + table["name"] + '": ' if len(TABLES) > 1 else ""
    item = table["item"]
    at = table_base(page, table, resolved)
    if not at:
        # A framed table whose frame did not resolve or load: no rows, and every required target missing.
        return {
            "name": table["name"],
            "rows": [],
            "container_count": 0,
            "first_row": None,
            "dropped_fields": [],
            "missing_required": ["frame"] + (["item"] if item else []) + [f["name"] for f in table["fields"] if not f["optional"]],
            "warnings": [prefix + "frame missing on page " + str(page_number)],
            "resolved": None,
        }
    base, frame_selectors = at
    # List parent, then the item container inside it.
    containers = [None]
    item_selectors = None
    within_selectors = None
    within_missing = False
    if item:
        root, within_selectors, within_missing = list_parent(base, item, resolved)
        selectors = resolved["item"] if resolved else item["selectors"]
        found = resolve_first(root, selectors) if selectors and not within_missing else None
        containers = kept_containers(base, found, item["exclude"]) if found else []
        item_selectors = resolved["item"] if resolved else (item["selectors"][found.index:] if found else None)
    real = [c for c in containers if c is not None]

    # Fields: settle each once, then read every row.
    states = []
    for index, field in enumerate(table["fields"]):
        if resolved:
            selectors = resolved["fields"][index]
        elif field["scope"] == "page":
            selectors = settle_selectors(field["selectors"], [base])
        elif item and not real:
            selectors = None
        else:
            selectors = settle_selectors(field["selectors"], real or [base])
        state = {"field": field, "selectors": selectors, "page_value": None, "missing_rows": []}
        if field["scope"] == "page":
            found = resolve_first(base, selectors) if selectors else None
            state["page_value"] = field_value(page, field, found.locator.nth(0) if found else None, page_url)
        states.append(state)

    extracted = []
    for index, container in enumerate(containers[from_index:]):
        row = {"_page": page_number, "_index": index}
        for state in states:
            result = state["page_value"]
            if result is None:
                # Only the settled primary per row, unless the field falls back to later candidates.
                selectors = state["selectors"] if state["field"]["fallback"] else state["selectors"][:1] if state["selectors"] else None
                found = resolve_first(container if container is not None else base, selectors) if selectors else None
                result = field_value(page, state["field"], found.locator.nth(0) if found else None, page_url)
            if not result[1]:
                state["missing_rows"].append(index)
            row[state["field"]["name"]] = result[0]
        extracted.append(row)
    container_count = len(extracted)

    # Drop rows on which a required field resolved nothing or read empty.
    required = [s for s in states if not s["field"]["optional"]]
    rows = []
    for index, row in enumerate(extracted):
        if not any(index in s["missing_rows"] for s in required):
            rows.append({**row, "_index": len(rows)})

    missing_required = []
    warnings = []
    dropped_fields = []
    if within_missing:
        missing_required.append("within")
    if item and container_count == 0:
        missing_required.append("item")
    for state in required:
        field, missing_rows = state["field"], state["missing_rows"]
        n = len(missing_rows)
        if n:
            dropped_fields.append(field["name"])
        missing = container_count == 0 or n == container_count
        if missing and container_count:
            missing_required.append(field["name"])
        if not missing and n:
            warnings.append(
                prefix + "dropped " + str(n) + " row" + ("s" if n > 1 else "") + " on page " + str(page_number)
                + ': required field "' + field["name"] + '" missing on row' + ("s " if n > 1 else " ")
                + ", ".join(str(i) for i in missing_rows)
            )
    settled = None if item and container_count == 0 and not resolved else {
        "frame": frame_selectors,
        "item": item_selectors,
        "within": within_selectors,
        "fields": [s["selectors"] for s in states],
    }
    return {
        "name": table["name"],
        "rows": rows,
        "container_count": container_count,
        "first_row": extracted[0] if extracted else None,
        "dropped_fields": dropped_fields,
        "missing_required": missing_required,
        "warnings": warnings,
        "resolved": settled,
    }


# ---------------------------------------------------------------------------
# Dedup and stop rules (core pagination/dedup.ts)
# ---------------------------------------------------------------------------


def to_json(value):
    """JSON as JavaScript's JSON.stringify writes it."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def key_of(table, row):
    """A row's identity: the table's key field value, or all of its field values in recipe order. Keys never cross tables."""
    key = table["key"]
    return to_json(row[key] if key is not None else [row[f["name"]] for f in table["fields"]])


def dedup_rows(table, rows, page_number, seen):
    """Rows of one table not seen on an earlier page (nor earlier on this one); page 1 keeps every row."""
    keys = [key_of(table, row) for row in rows]
    kept = []
    fresh = set()
    for row, key in zip(rows, keys):
        if page_number == 1 or (key not in seen and key not in fresh):
            kept.append(row)
        fresh.add(key)
    return kept, keys


def evaluate_stop(current, previous, limit):
    """Stop rules in order: empty page, loop guard, no-new-items, first-item-repeats, kind none, limit, cap. Returns (reason, discard)."""
    rules = PAGINATION["stopRules"]
    if previous:
        if current["raw"] == 0:
            return "no-new-items", True
        same_first = current["first_key"] is not None and current["first_key"] == previous["first_key"]
        if same_first and current["url"] == previous["url"]:
            return "loop", False
        if "no-new-items" in rules and current["kept"] == 0:
            return "no-new-items", False
        if "first-item-repeats" in rules and same_first:
            return "first-item-repeats", True
    if PAGINATION["kind"] == "none":
        return "none", False
    if limit != "all" and current["page"] >= limit:
        return "limit", False
    if limit == "all" and current["page"] >= DEFAULT_PAGE_CAP:
        return "cap", False
    return None, False


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


class RowSink:
    """
    Where rows go: stdout, --out, or one file per table; a JSON document at the
    end or one JSON object per line as pages complete. One table (or --table,
    or a directory) keeps the single table shapes: a JSON array, or plain JSONL
    rows. Several tables to one target give a JSON object keyed by table name,
    or JSONL rows carrying _table.
    """

    def __init__(self, jsonl, out, out_dir, only):
        self.jsonl = jsonl
        self.out = out
        self.out_dir = out_dir
        # Tables written, in recipe order.
        self.selected = [only] if only is not None else [table["name"] for table in TABLES]
        # Several tables share one target.
        self.combined = not out_dir and len(self.selected) > 1
        self.buffered = {}
        self.opened = set()

    def write(self, table, chunk):
        path = os.path.join(self.out, table + (".jsonl" if self.jsonl else ".json")) if self.out and self.out_dir else self.out
        if not path:
            sys.stdout.write(chunk)
            sys.stdout.flush()
            return
        mode = "a" if path in self.opened else "w"
        if path not in self.opened:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            self.opened.add(path)
        with open(path, mode, encoding="utf-8") as file:
            file.write(chunk)

    def row(self, table, row):
        if table not in self.selected:
            return
        if self.jsonl:
            self.write(table, to_json({"_table": table, **row} if self.combined else row) + "\n")
        else:
            self.buffered.setdefault(table, []).append(row)

    def finish(self):
        if self.jsonl:
            # Files exist even for a table without rows.
            for table in self.selected:
                self.write(table, "")
        elif self.combined:
            document = {table: self.buffered.get(table, []) for table in self.selected}
            self.write("", json.dumps(document, ensure_ascii=False, indent=2) + "\n")
        else:
            for table in self.selected:
                self.write(table, json.dumps(self.buffered.get(table, []), ensure_ascii=False, indent=2) + "\n")


# ---------------------------------------------------------------------------
# The sequence (core sequence/index.ts)
# ---------------------------------------------------------------------------


class Skipped(Exception):
    """An optional step is skipped, so the loop moves on."""


class Recheck:
    """Re-checks an await-user condition at once when Enter is pressed on a terminal."""

    _event = None

    def __init__(self):
        self.interactive = sys.stdin is not None and sys.stdin.isatty()
        if self.interactive and Recheck._event is None:
            # One reader for the whole run: a thread blocked on a terminal cannot be stopped.
            Recheck._event = threading.Event()
            threading.Thread(target=Recheck._read, daemon=True).start()
        if Recheck._event is not None:
            Recheck._event.clear()

    @staticmethod
    def _read():
        while sys.stdin.readline():
            Recheck._event.set()

    def wait(self, ms):
        """Wait the interval, or less when Enter is pressed."""
        if Recheck._event is None:
            sleep_ms(ms)
            return
        if Recheck._event.wait(ms / 1000):
            Recheck._event.clear()


def describe(target):
    """A target as stderr names it: its first candidate, and the iframe it sits in."""
    first = target["selectors"][0] if target["selectors"] else None
    text = first["strategy"] + "=" + first["value"] if first else "the target"
    if target["frame"]:
        frame = target["frame"][0]
        text += " inside iframe " + frame["strategy"] + "=" + frame["value"]
    return text


class Run:
    """
    Runs the recipe's sequence on the main window: called flows, extractions,
    and the paginate block's page loop, with reactive flows at every
    checkpoint and recovery of the page state after one.
    """

    def __init__(self, windows, values, sink, first_url, start, limit, await_timeout_ms):
        self.windows = windows
        self.values = values
        self.sink = sink
        self.first_url = first_url
        self.start = start
        self.limit = limit
        self.await_timeout_ms = await_timeout_ms
        # Per table: selectors settled (missing before its first extraction, None while it still has to be resolved), and keys seen.
        self.tables = [{"table": t, "first": True, "resolved": None, "seen": set() if t["item"] else None} for t in TABLES]
        self.lead = TABLES[LEAD]["name"] if LEAD >= 0 else None
        self.reactive = [f for f in FLOWS if f["trigger"]]
        self.retries = {}
        self.cache = {}
        self.page = 1
        # The main window's URL as the run last saw it settle.
        self.page_url = ""
        # Where the batch began (the last page the run navigated to itself) and the called flows it ran, for recovery.
        self.batch = {"url": first_url, "flows_run": []}
        self.paginating = False
        # A reactive flow is running: no trigger fires until it ends.
        self.reacting = False
        # Selectors the pagination target and its frame settled on the first time they were found.
        self.target_selectors = None
        self.row_count = 0
        # Pages whose rows were emitted; a discarded last page does not count.
        self.page_count = 0

    @property
    def main(self):
        return self.windows.main

    def state_of(self, name):
        return next((s for s in self.tables if s["table"]["name"] == name), None)

    def run(self):
        """Navigate to the first page, then run every block of the sequence. Returns why the page loop ended."""
        log("running " + RECIPE_NAME + ": " + self.first_url)
        self.loaded(self.main.goto(self.first_url))
        reason = "none"
        for block in SEQUENCE:
            if "paginate" in block:
                reason = self.paginate(block["paginate"])
            else:
                self.inner(block, None)
        # Without pagination the run is one page, with rows or not.
        if not any("paginate" in b for b in SEQUENCE):
            self.page_count = 1
        return reason

    def loaded(self, url):
        """A settled main window page: let reactive flows look at it."""
        self.page_url = url
        self.checkpoint()

    def inner(self, block, driving):
        """A flow or extract block, outside or inside the paginate block. driving is (name, from_index) inside it."""
        if "flow" in block:
            self.called_flow(block["flow"])
            return None
        from_index = driving[1] if driving and driving[0] == block["extract"] else 0
        extracted = self.extract(block["extract"], from_index)
        if not driving:
            self.emit(extracted)
        return extracted

    # Flows

    def called_flow(self, name):
        self.run_flow(next(f for f in FLOWS if f["name"] == name), "called", self.main)
        self.batch["flows_run"].append(name)

    def run_flow(self, flow, kind, origin):
        """
        Replay a flow's steps in order, in the window each step names: same is
        the window the flow started in, popup the newest popup opened since. An
        optional step whose target or window is not found is skipped; a required
        one fails the run with exit 3 naming the flow and the step.
        """
        log("flow " + flow["name"] + " (" + kind + ") on page " + str(self.page))
        mark = self.windows.mark()
        for step in flow["steps"]:
            self.checkpoint()
            named = "" if step["name"] == step["flow"] + ":" + str(step["index"]) else ' "' + step["name"] + '"'
            label = 'flow "' + step["flow"] + '" step ' + str(step["index"]) + named + " (" + step["kind"] + ") on page " + str(self.page)
            action = step["action"]

            def fail(why):
                if not step["optional"]:
                    # Names, never values: a fill's value may hold a secret.
                    uses = action["vars"] if action["kind"] == "fill" else []
                    source = " (value from variable" + ("s " if len(uses) > 1 else " ") + ", ".join(uses) + ")" if uses else ""
                    raise Failure("required step " + str(step["index"]) + " (" + step["kind"] + ') of flow "' + step["flow"] + '" '
                                  + why + source + " [" + step["name"] + "]", EXIT_UNRESOLVED)
                log(label + ": skipped (" + why + ")")
                raise Skipped()

            try:
                window = self.windows.wait_for_popup(mark) if step["window"] == "popup" else origin
                # Once the popup of an await-user step is gone, its condition is checked from the flow's window.
                if action["kind"] == "await-user" and (window is None or window.is_closed()) and self.windows.opened_since(mark):
                    window = origin
                if window is None or window.is_closed():
                    fail("found no popup within " + str(NAVIGATION_TIMEOUT_MS) + " ms" if step["window"] == "popup" else "found its window closed")
                if action["kind"] == "sleep":
                    sleep_ms(action["ms"])
                    log(label + ": ok")
                    continue
                if action["kind"] == "await-user":
                    self.await_user(step, action, window)
                    log(label + ": ok")
                    continue
                target = None
                if step["target"]:
                    target, why = find_step_target(window, step, self.cache)
                    if target is None:
                        fail(why)
                files = path_files(action, self.values) if action["kind"] == "fill" else None
                previous_url = window.page.url
                try:
                    if action["kind"] == "click":
                        window.click(target)
                    elif action["kind"] == "fill":
                        window.fill(target, fill_text(action["text"], self.values), files)
                    elif action["kind"] == "press":
                        window.press(action["key"], target)
                except (Failure, Skipped):
                    raise
                except Unresolved as error:
                    fail("found no element: " + str(error))
                except Exception as error:
                    fail("could not run: " + str(error))
                if action["kind"] != "wait-for" and not window.is_closed():
                    # A step that closes its popup (a login that is done) has nothing to settle.
                    try:
                        settled = window.settle(previous_url)
                    except PlaywrightError:
                        if not window.is_closed():
                            raise
                        settled = None
                    if settled is not None and window is self.main:
                        self.page_url = settled
                log(label + ": ok")
            except Skipped:
                continue

    def checkpoint(self):
        """
        A checkpoint: fire the first reactive flow, in recipe order, whose trigger
        resolves in any open window. Nothing fires while a reactive flow runs. A
        flow that would fire more than its maxRetries since the last successful
        extraction fails the run.
        """
        if self.reacting or not self.reactive:
            return
        windows = self.windows.open()
        for flow in self.reactive:
            for window in windows:
                if not target_present(window, flow["trigger"]):
                    continue
                fired = self.retries.get(flow["name"], 0) + 1
                if fired > flow["maxRetries"]:
                    raise Failure('reactive flow "' + flow["name"] + '" fired more than ' + str(flow["maxRetries"])
                                  + " times without a successful extraction in between", EXIT_ERROR)
                self.retries[flow["name"]] = fired
                self.reacting = True
                try:
                    self.run_flow(flow, "reactive", window)
                finally:
                    self.reacting = False
                if flow["recover"]:
                    self.recover()
                return

    def await_holds(self, target, until):
        """Whether an await-user condition holds: the target resolves (appears) or resolves nowhere (disappears), in any open window."""
        present = any(target_present(window, target) for window in self.windows.open())
        return not present if until == "disappears" else present

    def await_user(self, step, action, window):
        """
        An await-user step: print what it waits for on stderr, then check the
        condition every second (each tick a checkpoint) or at once on Enter,
        until it holds or the timeout runs out (exit 2).
        """
        target = step["target"]
        if self.await_holds(target, action["until"]):
            return
        timeout_ms = action["timeoutMs"] if action["timeoutMs"] is not None else self.await_timeout_ms
        recheck = Recheck()
        log("waiting for you: " + action["label"] + " (until " + describe(target) + " " + action["until"]
            + ", up to " + str(timeout_ms) + " ms" + ("; press Enter to check again" if recheck.interactive else "") + ")")
        try:
            window.page.bring_to_front()
        except PlaywrightError:
            pass
        deadline = now_ms() + timeout_ms
        while True:
            self.checkpoint()
            if self.await_holds(target, action["until"]):
                return
            left = deadline - now_ms()
            if left <= 0:
                raise Failure('await-user step "' + action["label"] + '" of flow "' + step["flow"] + '" was not completed within '
                              + str(timeout_ms) + " ms", EXIT_PAUSED)
            recheck.wait(min(AWAIT_POLL_MS, left))

    def recover(self):
        """
        Restore the state the sequence had built: go back to where the batch
        began and replay the called flows it ran. Skipped when no flow ran and
        the main window is already there. On page 2 or later of next or more
        pagination the state cannot be rebuilt: the run fails.
        """
        kind = PAGINATION["kind"]
        if self.paginating and kind in ("next", "more") and self.page >= 2:
            raise Failure("run failed (pagination-lost): the page state of page " + str(self.page) + " cannot be rebuilt after an interruption, since "
                          + kind + " pagination reached it by clicking; rows of earlier pages are kept", EXIT_ERROR, True)
        flows = list(self.batch["flows_run"])
        if not flows and same_url(self.main.page, self.main.page.url, self.batch["url"]):
            return
        log("recovering page " + str(self.page) + ": " + self.batch["url"])
        url = self.main.goto(self.batch["url"])
        self.batch["flows_run"] = []
        self.loaded(url)
        for name in flows:
            self.called_flow(name)

    # Extraction

    def extract(self, name, from_index):
        """Extract one table on the main window's current page. The rows are deduplicated, not emitted: (found, kept, keys)."""
        self.checkpoint()
        state = self.state_of(name)
        found = extract_table(self.main.page, state["table"], self.page, self.page_url, state["resolved"], from_index)
        self.settle(state, found)
        # A successful extraction gives every reactive flow its retries back.
        self.retries.clear()
        if state["seen"] is None:
            return found, found["rows"], []
        kept, keys = dedup_rows(state["table"], found["rows"], self.page, state["seen"])
        return found, kept, keys

    def settle(self, state, found):
        """Apply the first extraction rules: required targets and rows; later pages fail only for a field gone from every item."""
        at = 'table "' + found["name"] + '": ' if len(TABLES) > 1 else ""
        first = state["first"]
        names = found["missing_required"]
        if first and found["name"] != self.lead and ("item" in names or "within" in names):
            # A secondary list absent from the page is normal: no rows for it, not a failure.
            log("warning: " + at + "the item container matched no element on page " + str(self.page) + "; the table yields no rows")
            names = [n for n in names if n not in ("item", "within")]
        if first:
            if names:
                if "within" in names:
                    message = "the list parent (item.within) matched no element, so the item container is unresolved"
                elif "item" in names:
                    message = "the item container matched no element"
                else:
                    message = "required field" + ("s " if len(names) > 1 else " ") + ", ".join(names) + " matched no element"
                raise Failure(at + message, EXIT_UNRESOLVED)
            if found["container_count"] and not found["rows"]:
                fields = found["dropped_fields"]
                raise Failure(at + "every row on page " + str(self.page) + " was dropped for missing required field"
                              + ("s " if len(fields) > 1 else " ") + ", ".join(fields), EXIT_UNRESOLVED)
        else:
            # A later page with no items is the end of the list, not a failure; a field gone from every item is.
            gone = [n for n in names if n not in ("item", "within")]
            if gone:
                raise Failure(at + "required field" + ("s " if len(gone) > 1 else " ") + ", ".join(gone)
                              + " matched no element on page " + str(self.page), EXIT_UNRESOLVED)
        state["first"] = False
        if not state["resolved"]:
            state["resolved"] = found["resolved"]
        for warning in found["warnings"]:
            log("warning: " + warning)

    def emit(self, extracted):
        """Emit an extraction's rows."""
        found, kept, keys = extracted
        state = self.state_of(found["name"])
        if state["seen"] is not None:
            state["seen"].update(keys)
        for at, row in enumerate(kept):
            row["_index"] = at
            self.sink.row(found["name"], row)
        self.row_count += len(kept)
        self.page_count = max(self.page_count, self.page)

    # Pagination

    def paginate(self, blocks):
        """The page loop: run the inner blocks on each page, then advance, until a stop rule, the limit, or the cap."""
        driving = PAGINATION["table"]
        lead = self.state_of(driving) if driving is not None else None
        self.paginating = True
        previous = None
        from_index = 0
        try:
            while True:
                extracted = []
                for block in blocks:
                    result = self.inner(block, (driving, from_index))
                    if result is not None:
                        extracted.append(result)
                page = self.page
                head = next((e for e in extracted if e[0]["name"] == driving), None)
                if head is not None and lead is not None and lead["seen"] is not None:
                    summary = {
                        "page": page,
                        "url": self.page_url,
                        "first_key": key_of(lead["table"], head[0]["first_row"]) if head[0]["first_row"] is not None else None,
                        "raw": head[0]["container_count"],
                        "kept": len(head[1]),
                    }
                else:
                    # Without a driving table every page counts as one item, so only the limit, the cap, or a missing target stop the run.
                    summary = {"page": page, "url": self.page_url, "first_key": None, "raw": 1, "kept": 1}
                reason, discard = evaluate_stop(summary, previous, self.limit)
                if not discard:
                    for e in extracted:
                        self.emit(e)
                    self.page_count = page
                if reason:
                    return reason

                if PAGINATION["delayMs"] > 0:
                    sleep_ms(PAGINATION["delayMs"])
                kind, value = self.next_page(page)
                if kind == "stop":
                    return value
                previous = summary
                self.page += 1
                if kind == "page":
                    from_index = 0
                    # Only a page the run navigated to itself starts a new batch.
                    if PAGINATION["kind"] == "url":
                        self.batch = {"url": value, "flows_run": []}
                    self.loaded(value)
                else:
                    from_index = value
        finally:
            self.paginating = False

    def count(self):
        """Driving table item containers on the main window now."""
        state = self.state_of(PAGINATION["table"]) if PAGINATION["table"] is not None else None
        return count_items(self.main.page, state["table"] if state else None, state["resolved"] if state else None)

    def usable_target(self):
        """The pagination target, or None when it is missing or disabled."""
        stored = PAGINATION["target"]
        if not stored:
            return None
        page = self.main.page
        settled = self.target_selectors
        root = page
        frame_selectors = None
        frame_at = settled["frame"] if settled and settled["frame"] else stored["frame"]
        if frame_at:
            frame = frame_root(page, frame_at, NAVIGATION_TIMEOUT_MS)
            if not frame:
                return None
            root, frame_selectors = frame
        found = resolve_first(root, settled["selectors"] if settled else stored["selectors"])
        if not found:
            return None
        if not settled:
            self.target_selectors = {"selectors": stored["selectors"][found.index:], "frame": frame_selectors}
        target = found.locator.nth(0)
        return None if target.evaluate(PAGE_JS["isDisabled"]) else target

    def wait_for_growth(self, before):
        """Poll the item count until it exceeds before or the timeout passes."""
        deadline = now_ms() + NAVIGATION_TIMEOUT_MS
        while True:
            if self.count() > before:
                return True
            if now_ms() >= deadline:
                return False
            sleep_ms(GROWTH_POLL_MS)

    def next_page(self, page_number):
        """Advance: ("page", url), ("grown", from_index), or ("stop", reason)."""
        session = self.main
        kind = PAGINATION["kind"]
        if kind == "none":
            return "stop", "none"
        if kind == "url":
            log("page " + str(page_number + 1) + ": url")
            return "page", session.goto(url_for(session.page, self.values, self.start, page_number + 1))
        if kind == "next":
            target = self.usable_target()
            if target is None:
                return "stop", "target-missing"
            log("page " + str(page_number + 1) + ": next")
            previous_url = session.page.url
            session.click(target)
            return "page", session.settle(previous_url)
        if kind == "more":
            target = self.usable_target()
            if target is None:
                return "stop", "target-missing"
            before = self.count()
            log("page " + str(page_number + 1) + ": more")
            session.click(target)
            return ("grown", before) if self.wait_for_growth(before) else ("stop", "no-growth")
        before = self.count()
        log("page " + str(page_number + 1) + ": scroll")
        session.scroll_to_bottom()
        return ("grown", before) if self.wait_for_growth(before) else ("stop", "no-growth")


# ---------------------------------------------------------------------------
# The run (core runner.ts)
# ---------------------------------------------------------------------------


def scrape(opts):
    given = {name: read_source(name, source) for name, source in opts.vars.items()}
    values = resolve_vars(given)
    start = page_start(given)
    # Build the first URL once without the browser, so a bad template fails before it opens.
    url_for(None, values, start, 1)
    limit = opts.pages if opts.pages is not None else PAGINATION["limit"]

    profile_dir = os.path.abspath(opts.profile) if opts.profile else tempfile.mkdtemp(prefix="webscoop-export-")
    os.makedirs(profile_dir, exist_ok=True)
    executable_path = os.environ.get("WEBSCOOP_CHROMIUM", "").strip() or None
    launch = {
        "headless": opts.headless,
        "no_viewport": True,
        "ignore_default_args": IGNORED_DEFAULT_ARGS,
        "args": STEALTH_ARGS,
    }
    if opts.headless:
        # Headless runs use Chromium's new headless mode in the full browser, not the separate headless shell.
        launch["channel"] = "chromium"
    if executable_path:
        launch["executable_path"] = executable_path
    sink = RowSink(opts.jsonl, os.path.abspath(opts.out) if opts.out else None, opts.out_dir, opts.table)
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(profile_dir, **launch)
            try:
                context.set_default_timeout(ACTION_TIMEOUT_MS)
                context.set_default_navigation_timeout(NAVIGATION_TIMEOUT_MS)
                main_session = Session(context.pages[0] if context.pages else context.new_page())
                first_url = url_for(main_session.page, values, start, 1)
                run = Run(Windows(context, main_session), values, sink, first_url, start, limit, opts.await_timeout)
                reason = run.run()
                if reason == "cap":
                    log("warning: stopped at the page cap of " + str(DEFAULT_PAGE_CAP) + " pages")
                elif reason not in ("limit", "none"):
                    log("pagination stopped after page " + str(run.page_count) + ": " + reason)
                sink.finish()
                log(str(run.row_count) + " row" + ("" if run.row_count == 1 else "s") + " from " + str(run.page_count)
                    + " page" + ("" if run.page_count == 1 else "s"))
                return EXIT_OK
            except Failure as failure:
                if failure.keep_rows:
                    sink.finish()
                raise
            finally:
                try:
                    context.close()
                except PlaywrightError:
                    pass
    finally:
        if not opts.profile:
            shutil.rmtree(profile_dir, ignore_errors=True)


def main(argv):
    try:
        return scrape(parse_args(argv))
    except Failure as failure:
        log(str(failure))
        return failure.code
    except Exception as error:
        log("error: " + str(error))
        return EXIT_ERROR
`;
