#!/usr/bin/env node

/**
 * worker_stdout_tee.js — stdout tee helper for agy worker recovery
 *
 * Usage: node worker_stdout_tee.js <outPath> -- <cmd> [args...]
 *
 * Streams child stdout to BOTH process.stdout (passthrough) AND appends to outPath.
 * Child stderr passes through unchanged (no capture).
 * Exit code propagates from child.
 *
 * Degradation modes:
 * - Empty string outPath ("") → plain passthrough, no file I/O
 * - Unwritable outPath (ENOENT parent, permission denied) → warning to stderr, then plain passthrough
 *
 * This script is invoked by the agy.cmd shim when AGY_TEE_OUT is set, enabling
 * the orphan reaper to recover sessionless workers' replies after a bot crash.
 * See the 2026-08-15 agy-tee-recovery spec §WP1.1
 */

const { spawn } = require('child_process');
const { createWriteStream, existsSync } = require('fs');
const { dirname } = require('path');

// Parse argv: node worker_stdout_tee.js <outPath> -- <cmd> [args...]
const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');

if (separatorIndex === -1 || separatorIndex === 0) {
  console.error('Usage: node worker_stdout_tee.js <outPath> -- <cmd> [args...]');
  process.exit(1);
}

const outPath = args[0];
const cmdAndArgs = args.slice(separatorIndex + 1);

if (cmdAndArgs.length === 0) {
  console.error('Error: no command specified after --');
  process.exit(1);
}

const cmd = cmdAndArgs[0];
const childArgs = cmdAndArgs.slice(1);

// Determine if we should tee to file
const shouldTee = outPath !== '';
let writeStream = null;
let fileError = false;

if (shouldTee) {
  try {
    // Create parent directory if it doesn't exist
    const parentDir = dirname(outPath);
    if (!existsSync(parentDir)) {
      console.error(`warn: tee output directory does not exist: ${parentDir} — falling back to passthrough`);
      fileError = true;
    } else {
      // Open in append mode
      writeStream = createWriteStream(outPath, { flags: 'a' });
      writeStream.on('error', (err) => {
        console.error(`warn: failed to open tee output file ${outPath}: ${err.message} — falling back to passthrough`);
        fileError = true;
        writeStream = null;
      });
    }
  } catch (err) {
    console.error(`warn: error setting up tee output: ${err.message} — falling back to passthrough`);
    fileError = true;
  }
}

// Spawn the child process
const child = spawn(cmd, childArgs, {
  stdio: ['inherit', 'pipe', 'inherit'],
  windowsHide: true,
});

// Pipe child stdout to both process.stdout and the tee file
child.stdout.on('data', (chunk) => {
  // Always passthrough to parent
  process.stdout.write(chunk);

  // Also write to file if tee is active and no error
  if (shouldTee && writeStream && !fileError) {
    writeStream.write(chunk);
  }
});

// Propagate exit code from child
child.on('close', (code) => {
  // Flush and close the write stream before exiting
  if (writeStream && !fileError) {
    writeStream.end(() => {
      process.exit(code ?? 0);
    });
  } else {
    process.exit(code ?? 0);
  }
});

// Handle child spawn errors (e.g., command not found)
child.on('error', (err) => {
  console.error(`Error: failed to spawn child command: ${err.message}`);
  if (writeStream && !fileError) {
    writeStream.end(() => {
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
});
