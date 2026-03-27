const IS_PRODUCTION = process.env.NODE_ENV === "production";

export function redactAddress(addr: string): string {
  if (!IS_PRODUCTION || addr.length < 10) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export function redactAmount(amount: string | bigint): string {
  if (!IS_PRODUCTION) return amount.toString();
  return "***";
}
