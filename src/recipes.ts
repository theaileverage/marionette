import recipe0 from '../skills/marionette/references/recipes/diagnose.md' with { type: 'text' };
import recipe1 from '../skills/marionette/references/recipes/investigate.md' with { type: 'text' };
import recipe2 from '../skills/marionette/references/recipes/compare-approaches.md' with { type: 'text' };
import recipe3 from '../skills/marionette/references/recipes/review-repair.md' with { type: 'text' };
import recipe4 from '../skills/marionette/references/recipes/deliver.md' with { type: 'text' };
import recipe5 from '../skills/marionette/references/recipes/recover.md' with { type: 'text' };
import recipe6 from '../skills/marionette/references/recipes/catch-up.md' with { type: 'text' };
import multipleIntents from '../skills/marionette/references/recipes/multiple-intents.md' with { type: 'text' };

/** Source guidance is embedded identically in CLI and MCP bundles. */
export const recipes = [
  { name: 'diagnose', instructions: recipe0 },
  { name: 'investigate', instructions: recipe1 },
  { name: 'compare-approaches', instructions: recipe2 },
  { name: 'review-repair', instructions: recipe3 },
  { name: 'deliver', instructions: recipe4 },
  { name: 'recover', instructions: recipe5 },
  { name: 'catch-up', instructions: recipe6 },
  { name: 'multiple-intents', instructions: multipleIntents },
].map((recipe) => ({
  ...recipe,
  version:
    recipe.instructions
      .split('\n')
      .find((line) => line.startsWith('Version: '))
      ?.slice(9) ?? '',
  trigger:
    recipe.instructions
      .split('\n')
      .find((line) => line.startsWith('Trigger: '))
      ?.slice(9) ?? '',
}));
