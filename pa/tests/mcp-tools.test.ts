/**
 * MCP tools tests — verifies tool definitions, schemas, and the CLI-spawn pattern.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { mkdir, rm } from 'fs/promises';
import { tools, pa_ref_lookup, pa_claims, pa_maintenance_status, pa_costs, pa_slo_report, pa_recall } from '../mcp/tools.js';

describe('MCP tool definitions (Wave H WPH2)', () => {
  it('exports exactly six read-only tools', () => {
    assert.equal(tools.length, 6);
    const names = tools.map(t => t.name);
    assert.deepEqual(names.sort(), ['pa_claims', 'pa_costs', 'pa_maintenance_status', 'pa_recall', 'pa_ref_lookup', 'pa_slo_report']);
  });

  it('every tool has name, description, inputSchema, and handler', () => {
    for (const tool of tools) {
      assert.equal(typeof tool.name, 'string', `${tool.name}: name`);
      assert.equal(typeof tool.description, 'string', `${tool.name}: description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: schema type`);
      assert.equal(typeof tool.handler, 'function', `${tool.name}: handler`);
    }
  });

  it('pa_ref_lookup requires an id', () => {
    assert.ok(pa_ref_lookup.inputSchema.required.includes('id'));
    assert.ok(pa_ref_lookup.inputSchema.properties.id);
  });

  it('pa_costs accepts period and skill', () => {
    assert.ok(pa_costs.inputSchema.properties.period);
    assert.ok(pa_costs.inputSchema.properties.skill);
    assert.equal(pa_costs.inputSchema.properties.period.enum?.includes('week'), true);
  });

  it('pa_recall requires q', () => {
    assert.ok(pa_recall.inputSchema.required.includes('q'));
    assert.ok(pa_recall.inputSchema.properties.q);
  });

  it('pa_recall source enum includes decisions (AI-164)', () => {
    assert.ok(pa_recall.inputSchema.properties.source.enum.includes('decisions'));
  });

  it('no tool has a mutating verb in its name (read-only surface)', () => {
    for (const tool of tools) {
      assert.ok(!/write|create|delete|update|push|commit|run/i.test(tool.name), `read-only: ${tool.name}`);
    }
  });
});

describe('MCP tool handlers (CLI spawn pattern)', () => {
  it('pa_claims returns text (spawns pa claims)', async () => {
    const out = await pa_claims.handler();
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0, 'some output returned');
  });

  it('pa_maintenance_status returns text (spawns pa maintenance status)', async () => {
    const out = await pa_maintenance_status.handler();
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0, 'some output returned');
  });
});
