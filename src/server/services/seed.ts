import 'server-only'
import { EXAMPLE_RECIPES, RecipeDefinition } from '@/core/recipe'
import { EXAMPLE_TEMPLATES, TemplateDefinition } from '@/core/template'
import { newAppId } from '@/core/ids'
import type { AppContext } from '../context'

/**
 * Adds the example templates (always kept up to date, read-only) and, on first run only,
 * the example recipes (yours to edit or delete afterwards). Also applies one-time updates
 * to existing settings.
 */
export function seedExamples(ctx: Pick<AppContext, 'repos'>) {
  for (const example of EXAMPLE_TEMPLATES) {
    const definition = TemplateDefinition.parse(example.definition)
    if (ctx.repos.templates.get(example.id)) ctx.repos.templates.update(example.id, definition)
    else ctx.repos.templates.insert(example.id, 'example', definition)
  }
  if (ctx.repos.settings.get<boolean>('seed.recipes') !== true) {
    for (const example of EXAMPLE_RECIPES) ctx.repos.recipes.insert(newAppId('rcp'), RecipeDefinition.parse(example))
    ctx.repos.settings.set('seed.recipes', true)
  }
  // "Allow creation after approval" became the default. Switch it on once for recipes made
  // before that (each saved as a new version); you can still switch it off per recipe.
  if (ctx.repos.settings.get<boolean>('migrate.allowCreateDefault') !== true) {
    for (const recipe of ctx.repos.recipes.list()) {
      if (!recipe.definition.allowCreate) ctx.repos.recipes.update(recipe.id, { ...recipe.definition, allowCreate: true }, recipe.version)
    }
    ctx.repos.settings.set('migrate.allowCreateDefault', true)
  }
}
