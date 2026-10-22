// Visual system from the spec: dark, one accent, grey (never red) for breaks.
export const colors = {
  background: '#121212', // Onyx
  surface: '#1C1C1E',
  surfaceRaised: '#2C2C2E',
  text: '#F5F5F7',
  textSecondary: '#8E8E93',
  accent: '#FF5722', // Ember: live streak, pending actions
  done: '#10B981', // Done Green
  broken: '#8E8E93',
} as const;

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { md: 12, lg: 20, pill: 999 } as const;
