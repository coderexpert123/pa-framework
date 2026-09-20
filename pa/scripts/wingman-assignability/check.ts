import type { JevAsk, WingmanPlugin } from 'jev-browser-wingman/contract';
import { askSystemOne } from '../../src/lib/typesafe-client.js';
import { wingmanPlugin } from '../../src/lib/wingman-plugin.js';
const ask: JevAsk = askSystemOne;
const plugin: WingmanPlugin = wingmanPlugin;
void ask;
void plugin;
