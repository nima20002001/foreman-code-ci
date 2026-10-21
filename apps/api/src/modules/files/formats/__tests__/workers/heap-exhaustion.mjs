// Retain distinct objects until the child reaches its V8 old-space limit.
import process from "node:process";
process.once("message", () => {
  const retained = [];
  for (let i = 0; ; i++) retained.push({ value: i, padding: String(i).repeat(32) });
});
