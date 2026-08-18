const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};

function style(value: string, enabled: boolean, ...codes: string[]): string {
  return enabled ? `${codes.join("")}${value}${ANSI.reset}` : value;
}

function sanitize(value: string): string {
  return value
    .replaceAll("\r", "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function renderInline(value: string, ansi: boolean): string {
  const codeSpans: string[] = [];
  let rendered = value.replace(/(`+)(.*?)\1/g, (_match, _ticks, code: string) => {
    const index = codeSpans.push(style(code, ansi, ANSI.cyan)) - 1;
    return `\uE000${index}\uE001`;
  });

  rendered = rendered.replace(
    /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) =>
      `${style(label, ansi, ANSI.underline)} ${style(`(${url})`, ansi, ANSI.dim)}`,
  );
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, (_match, content: string) =>
    style(content, ansi, ANSI.bold),
  );
  rendered = rendered.replace(/__([^_\n]+)__/g, (_match, content: string) =>
    style(content, ansi, ANSI.bold),
  );
  rendered = rendered.replace(/~~([^~\n]+)~~/g, "$1");
  rendered = rendered.replace(
    /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
    (_match, content: string) => style(content, ansi, ANSI.italic),
  );
  rendered = rendered.replace(
    /(?<!_)_([^_\n]+)_(?!_)/g,
    (_match, content: string) => style(content, ansi, ANSI.italic),
  );

  return rendered.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => {
    return codeSpans[Number(index)] ?? "";
  });
}

export function renderMarkdown(markdown: string, ansi = true): string {
  const lines = sanitize(markdown).split("\n");
  const output: string[] = [];
  let codeFence = false;

  for (const line of lines) {
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      codeFence = !codeFence;
      const language = fence[1]?.trim();
      if (codeFence && language) {
        output.push(style(`  ${language}`, ansi, ANSI.dim));
      }
      continue;
    }

    if (codeFence) {
      output.push(`${style("  │", ansi, ANSI.dim)} ${line}`);
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(style(renderInline(heading[1] ?? "", ansi), ansi, ANSI.bold));
      continue;
    }

    const task = line.match(/^(\s*)[-*+]\s+\[([ xX])]\s+(.+)$/);
    if (task) {
      const done = task[2]?.toLowerCase() === "x";
      const marker = style(done ? "✓" : "○", ansi, done ? ANSI.green : ANSI.dim);
      output.push(`${task[1]}${marker} ${renderInline(task[3] ?? "", ansi)}`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      const marker = style("•", ansi, ANSI.cyan);
      output.push(`${bullet[1]}${marker} ${renderInline(bullet[2] ?? "", ansi)}`);
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      const marker = style(`${ordered[2]}.`, ansi, ANSI.cyan);
      output.push(`${ordered[1]}${marker} ${renderInline(ordered[3] ?? "", ansi)}`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      output.push(
        `${style("│", ansi, ANSI.dim)} ${style(renderInline(quote[1] ?? "", ansi), ansi, ANSI.dim)}`,
      );
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      output.push(style("────────────────────────", ansi, ANSI.dim));
      continue;
    }

    output.push(renderInline(line, ansi));
  }

  return output.join("\n").trimEnd();
}
