export function table(headers: string[], rows: string[][], empty = "(none)"): string {
  if (rows.length === 0) return empty;

  const widths = headers.map((header, column) =>
    rows.reduce((width, row) => Math.max(width, (row[column] ?? "").length), header.length),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd();

  return [line(headers), ...rows.map((row) => line(row.map((cell) => cell ?? "")))].join("\n");
}

export function orDash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

export function shortTime(value: string | null | undefined): string {
  if (!value) return "-";
  return value.replace(/T(\d\d:\d\d):\d\d/, " $1");
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

export function print(value: unknown, asJson: boolean, human: () => string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
}
