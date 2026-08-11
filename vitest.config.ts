import { defineConfig } from 'vitest/config';

// Projects are listed explicitly rather than inferred from the npm workspaces,
// so test discovery does not shift as packages are added.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'cli',
          root: './apps/cli',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
