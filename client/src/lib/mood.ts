// Shared, human-readable takes on an agent's inner state, so every view
// (Team, Town, Home) describes feelings and friendships the same way.

/** Face for how an agent is feeling, from morale (and a sleepy face when energy is very low). */
export function moodFace(morale: number, energy = 100): string {
  if (energy < 20) return "😴";
  if (morale >= 85) return "😄";
  if (morale >= 65) return "🙂";
  if (morale >= 45) return "😐";
  if (morale >= 25) return "😟";
  return "😢";
}

/** How two agents feel about each other, from relationship sentiment (-100..100). */
export function affection(sentiment: number): { emoji: string; label: string } {
  if (sentiment >= 60) return { emoji: "💖", label: "Close friends" };
  if (sentiment >= 25) return { emoji: "😊", label: "Friendly" };
  if (sentiment >= -10) return { emoji: "🤝", label: "Colleagues" };
  if (sentiment >= -40) return { emoji: "😒", label: "Tense" };
  return { emoji: "💢", label: "At odds" };
}
