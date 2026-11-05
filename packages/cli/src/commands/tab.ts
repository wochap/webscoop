import { resolve } from 'node:path';
import type { CliIo } from '../context';
import { connectRunning, nextMessage, openDaemon } from '../daemon/client';
import type { TabActionRequest, TabActionResponse } from '../daemon/protocol';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';

export interface TabCommonOptions {
  profile?: string;
  json?: boolean;
}

export interface TabOpenOptions extends TabCommonOptions {
  visual?: boolean;
  humanize?: boolean;
  timeout?: number;
}

export interface TabActionOptions extends TabCommonOptions {
  timeout?: number;
  visual?: boolean;
}

export interface TabOutlineOptions extends TabCommonOptions {
  budget?: number;
}

export interface TabDownloadOptions extends TabCommonOptions {
  out: string;
  url?: string;
  timeout?: number;
  visual?: boolean;
}

export interface TabAttendOptions extends TabCommonOptions {
  reason?: string;
  timeout?: number;
}

export interface TabCloseOptions extends TabCommonOptions {
  all?: boolean;
}

async function sendTabRequest(
  io: CliIo,
  req: TabActionRequest,
  ensureDaemon = true,
): Promise<TabActionResponse> {
  const link = ensureDaemon ? await openDaemon(io) : await connectRunning(io);
  if (!link) {
    if (req.type === 'tab.list') {
      return { type: 'tab.list', tabs: [] };
    }
    if (req.type === 'tab.close') {
      return { type: 'tab.closed', closed: [] };
    }
    throw new CliError('no daemon running');
  }
  try {
    const replyPromise = nextMessage(link, (m) => m.type.startsWith('tab.'));
    link.send(req);
    const reply = await replyPromise;
    if (!reply || !reply.type.startsWith('tab.')) {
      throw new CliError('the daemon exited before answering');
    }
    const response = reply as TabActionResponse;
    if (response.type === 'tab.error') {
      throw new CliError(response.message);
    }
    return response;
  } finally {
    link.close();
  }
}

export async function tabOpenCommand(
  io: CliIo,
  url: string | undefined,
  opts: TabOpenOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.open',
    url,
    profile: opts.profile,
    visual: opts.visual,
    humanize: opts.humanize,
    timeoutMs: opts.timeout,
    cwd: io.cwd,
    env: io.env as Record<string, string>,
  });
  if (res.type !== 'tab.opened') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(res.tab, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.tab.tabId}  ${res.tab.url || 'about:blank'}  ${res.tab.title ? `"${res.tab.title}"` : ''}\n`);
  }
  return ExitCode.Ok;
}

export async function tabsCommand(
  io: CliIo,
  opts: TabCommonOptions,
): Promise<Code> {
  const res = await sendTabRequest(
    io,
    { type: 'tab.list', profile: opts.profile },
    false,
  );
  if (res.type !== 'tab.list') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(res.tabs, null, 2)}\n`);
  } else {
    if (res.tabs.length === 0) {
      io.stdout.write('no open tabs\n');
    } else {
      for (const t of res.tabs) {
        io.stdout.write(`${t.tabId}${t.isPopup ? ' (popup)' : ''}  ${t.url || 'about:blank'}  ${t.title ? `"${t.title}"` : ''}\n`);
      }
    }
  }
  return ExitCode.Ok;
}

export async function tabGotoCommand(
  io: CliIo,
  tabId: string,
  url: string,
  opts: TabActionOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.goto',
    tabId,
    url,
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.page') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, url: res.url, title: res.title, message: res.message }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.message}: ${res.url} ("${res.title}")\n`);
  }
  return ExitCode.Ok;
}

export async function tabBackCommand(
  io: CliIo,
  tabId: string,
  opts: TabActionOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.back',
    tabId,
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.page') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, url: res.url, title: res.title, message: res.message }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.message}: ${res.url} ("${res.title}")\n`);
  }
  return ExitCode.Ok;
}

export async function tabOutlineCommand(
  io: CliIo,
  tabId: string,
  opts: TabOutlineOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.outline',
    tabId,
    budgetTokens: opts.budget,
  });
  if (res.type !== 'tab.outline') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, url: res.url, title: res.title, outline: res.outline, cut: res.cut }, null, 2)}\n`);
  } else {
    io.stdout.write(`URL: ${res.url}\nTitle: ${res.title}\n${res.outline}\n`);
  }
  return ExitCode.Ok;
}

export async function tabFindCommand(
  io: CliIo,
  tabId: string,
  text: string,
  opts: TabCommonOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.find',
    tabId,
    text,
  });
  if (res.type !== 'tab.find') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(res.matches, null, 2)}\n`);
  } else {
    for (const match of res.matches) {
      io.stdout.write(`${match}\n`);
    }
  }
  return ExitCode.Ok;
}

export async function tabHtmlCommand(
  io: CliIo,
  tabId: string,
  target: string,
  opts: TabCommonOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.html',
    tabId,
    target,
  });
  if (res.type !== 'tab.html') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ html: res.html }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.html}\n`);
  }
  return ExitCode.Ok;
}

export async function tabClickCommand(
  io: CliIo,
  tabId: string,
  target: string,
  opts: TabActionOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.click',
    tabId,
    target,
    visual: opts.visual,
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.page') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, url: res.url, title: res.title, message: res.message }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.message}: ${res.url} ("${res.title}")\n`);
  }
  return ExitCode.Ok;
}

export async function tabFillCommand(
  io: CliIo,
  tabId: string,
  target: string,
  value: string,
  opts: TabActionOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.fill',
    tabId,
    target,
    value,
    visual: opts.visual,
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.page') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, url: res.url, title: res.title, message: res.message }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.message}: ${res.url} ("${res.title}")\n`);
  }
  return ExitCode.Ok;
}

export async function tabPressCommand(
  io: CliIo,
  tabId: string,
  key: string,
  target: string | undefined,
  opts: TabActionOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.press',
    tabId,
    key,
    target,
    visual: opts.visual,
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.page') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, url: res.url, title: res.title, message: res.message }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.message}: ${res.url} ("${res.title}")\n`);
  }
  return ExitCode.Ok;
}

export async function tabScrollCommand(
  io: CliIo,
  tabId: string,
  direction: string,
  opts: TabActionOptions,
): Promise<Code> {
  if (direction !== 'down' && direction !== 'up' && direction !== 'bottom') {
    throw new CliError('direction must be "down", "up", or "bottom"');
  }
  const res = await sendTabRequest(io, {
    type: 'tab.scroll',
    tabId,
    direction: direction as 'down' | 'up' | 'bottom',
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.page') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, url: res.url, title: res.title, message: res.message }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.message}: ${res.url} ("${res.title}")\n`);
  }
  return ExitCode.Ok;
}

export async function tabEvalCommand(
  io: CliIo,
  tabId: string,
  expression: string,
  opts: TabCommonOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.eval',
    tabId,
    expression,
  });
  if (res.type !== 'tab.eval') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
  } else {
    if (typeof res.result === 'string') {
      io.stdout.write(`${res.result}\n`);
    } else {
      io.stdout.write(`${JSON.stringify(res.result, null, 2)}\n`);
    }
  }
  return ExitCode.Ok;
}

export async function tabDownloadCommand(
  io: CliIo,
  tabId: string,
  target: string | undefined,
  opts: TabDownloadOptions,
): Promise<Code> {
  if (!opts.out) {
    throw new CliError('option --out <path> is required for download');
  }
  const outPath = resolve(io.cwd, opts.out);
  const res = await sendTabRequest(io, {
    type: 'tab.download',
    tabId,
    target,
    url: opts.url,
    outPath,
    visual: opts.visual,
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.download') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, file: res.file, bytes: res.bytes, url: res.url }, null, 2)}\n`);
  } else {
    io.stdout.write(`downloaded ${res.file} (${res.bytes} bytes)\n`);
  }
  return ExitCode.Ok;
}

export async function tabAttendCommand(
  io: CliIo,
  tabId: string,
  opts: TabAttendOptions,
): Promise<Code> {
  const res = await sendTabRequest(io, {
    type: 'tab.attend',
    tabId,
    reason: opts.reason,
    timeoutMs: opts.timeout,
  });
  if (res.type !== 'tab.page') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ tabId: res.tabId, message: res.message }, null, 2)}\n`);
  } else {
    io.stdout.write(`${res.message}\n`);
  }
  return ExitCode.Ok;
}

export async function tabCloseCommand(
  io: CliIo,
  tabId: string | undefined,
  opts: TabCloseOptions,
): Promise<Code> {
  const res = await sendTabRequest(
    io,
    {
      type: 'tab.close',
      tabId,
      profile: opts.profile,
      all: opts.all,
    },
    false,
  );
  if (res.type !== 'tab.closed') return ExitCode.Error;
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ closed: res.closed }, null, 2)}\n`);
  } else {
    if (res.closed.length > 0) {
      io.stdout.write(`closed: ${res.closed.join(', ')}\n`);
    } else {
      io.stdout.write('no tabs closed\n');
    }
  }
  return ExitCode.Ok;
}
