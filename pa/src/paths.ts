import { homedir } from 'os';
import { join } from 'path';

export function paHome(): string {
  return process.env.PA_HOME || join(homedir(), '.pa');
}

export function skillsDir(): string {
  return join(paHome(), 'skills');
}

export function logsDir(): string {
  return join(paHome(), 'logs');
}

export function draftsDir(): string {
  return join(paHome(), 'skill-drafts');
}

export function configPath(): string {
  return join(paHome(), 'config.yaml');
}

export function secretsPath(): string {
  return join(paHome(), 'secrets.env');
}

export function profilePath(): string {
  return join(paHome(), 'data', 'profile.json');
}
