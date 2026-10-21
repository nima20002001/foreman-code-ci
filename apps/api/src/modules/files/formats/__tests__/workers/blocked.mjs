// Hostile parser stand-in: the worker event loop cannot service a cooperative timeout.
process.once("message", () => { for (;;) { /* Parent must terminate this process. */ } });
import process from "node:process";
