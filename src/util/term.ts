const enabled = () => !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR) && process.env.TERM !== 'dumb';
const wrap = (open: number, close: number) => (s: string) => (enabled() ? `\u001b[${open}m${s}\u001b[${close}m` : s);
export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
};
