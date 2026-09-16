// Vercel Speed Insights initialization
import { injectSpeedInsights } from './vendor/@vercel/speed-insights/dist/index.mjs';

// Initialize Speed Insights
injectSpeedInsights({
  debug: false,
  // Enable debug mode only in development if needed
  // debug: window.location.hostname === 'localhost',
});
