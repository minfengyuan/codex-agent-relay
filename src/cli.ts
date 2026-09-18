#!/usr/bin/env node
import { runCli } from "./cli-runtime.js";
import { loadConfig } from "./config.js";

runCli(loadConfig());
