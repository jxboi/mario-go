/**
 * localStorage persistence for the game library.
 */

import { createGame } from './engine.js';

const KEY = 'go-journal.games.v1';
const SETTINGS_KEY = 'go-journal.settings.v1';

export function loadGames() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Re-hydrate through createGame so old records pick up new fields.
    return list.map((g) => createGame(g));
  } catch (err) {
    console.error('Failed to load games', err);
    return [];
  }
}

export function saveGames(games) {
  try {
    localStorage.setItem(KEY, JSON.stringify(games));
    return true;
  } catch (err) {
    console.error('Failed to save games', err);
    return false;
  }
}

export function upsertGame(game) {
  const games = loadGames();
  game.updatedAt = new Date().toISOString();
  const i = games.findIndex((g) => g.id === game.id);
  if (i >= 0) games[i] = game;
  else games.unshift(game);
  saveGames(games);
  return games;
}

export function deleteGame(id) {
  const games = loadGames().filter((g) => g.id !== id);
  saveGames(games);
  return games;
}

export function getGame(id) {
  return loadGames().find((g) => g.id === id) || null;
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.error('Failed to save settings', err);
  }
}
