/**
 * The SearXNG web-search provider's endpoint card.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { WebSearchCardFace } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the web-search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the web-search card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-web-search-endpoint"
        label={t('webSearchBaseUrl')}
        hint={t('webSearchBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
    </PluginCard>
  )
}
