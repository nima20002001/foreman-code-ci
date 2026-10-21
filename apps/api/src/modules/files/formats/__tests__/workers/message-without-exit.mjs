process.once("message", () => {
  process.send({ status: "ready", text: "premature", sections: [] });
  setInterval(() => {}, 1000);
});
import process from "node:process";
import { setInterval } from "node:timers";
