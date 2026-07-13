import { describe, expect, it } from 'vitest';
import { collectHostingEnvKeys, detectStack, isEmptyStack } from '../src/stack.js';
import type { WirePackage } from '../src/normalize.js';

const pkgs = (...names: string[]): WirePackage[] =>
  names.map((name) => ({ name, version: '1.0.0' }));

describe('detectStack', () => {
  it('identifies a Lovable + TanStack Start + React + Vite + Cloudflare build', () => {
    const stack = detectStack(
      pkgs(
        'lovable-tagger',
        '@tanstack/react-start',
        'react',
        'react-dom',
        'vite',
        'wrangler',
      ),
      {},
    );
    expect(stack.builder).toBe('lovable');
    expect(stack.framework).toBe('tanstack-start');
    expect(stack.ui).toBe('react');
    expect(stack.bundler).toBe('vite');
    expect(stack.runtime).toBe('cloudflare-workers');
    expect(stack.ecosystem).toBe('npm');
  });

  it('prefers the more specific meta-framework over react-router', () => {
    const next = detectStack(pkgs('next', 'react-router', 'react'), {});
    expect(next.framework).toBe('next');
  });

  it('returns nulls for an unrecognised stack without throwing', () => {
    const stack = detectStack(pkgs('left-pad'), {});
    expect(stack.framework).toBeNull();
    expect(stack.ui).toBeNull();
    expect(stack.bundler).toBeNull();
    expect(stack.builder).toBeNull();
    expect(isEmptyStack(stack)).toBe(true);
  });

  it('detects vue/nuxt independently of react rules', () => {
    const stack = detectStack(pkgs('nuxt', 'vue'), {});
    expect(stack.framework).toBe('nuxt');
    expect(stack.ui).toBe('vue');
  });
});

describe('collectHostingEnvKeys', () => {
  it('surfaces only hosting-related key names, sorted, never values', () => {
    const keys = collectHostingEnvKeys({
      VERCEL: '1',
      VERCEL_REGION: 'iad1',
      CF_PAGES: '1',
      HOME: '/root',
      SECRET_TOKEN: 'shh',
    });
    expect(keys).toEqual(['CF_PAGES', 'VERCEL', 'VERCEL_REGION']);
    expect(keys).not.toContain('SECRET_TOKEN');
    expect(keys).not.toContain('HOME');
  });

  it('returns an empty array when nothing matches', () => {
    expect(collectHostingEnvKeys({ HOME: '/root' })).toEqual([]);
  });
});
