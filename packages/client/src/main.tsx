import React from 'react';
import { createRoot } from 'react-dom/client';
import './global.css';
import { App } from './App';
import { LIGHT_ANIMATIONS_ENABLED } from './config/featureFlags';

if (LIGHT_ANIMATIONS_ENABLED) document.documentElement.dataset.lightAnim = '';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
