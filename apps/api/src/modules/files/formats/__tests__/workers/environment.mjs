process.once("message", () => {
  const text = `${process.env.FIL06_TEST_SECRET ?? "absent"}:${process.env.NODE_OPTIONS ?? "absent"}`;
  process.send({ status: "ready", text, sections: [] }, () => process.exit(0));
});
import process from "node:process";
