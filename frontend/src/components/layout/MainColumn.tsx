import SchemaPanel from '../schema/SchemaPanel'
import ChatPanel from '../chat/ChatPanel'
import { useSchemaStore } from '../../stores/schemaStore'

export default function MainColumn() {
  const systemMode = useSchemaStore((s) => s.systemMode)

  // empty: show schema panel (upload zone) + chat (placeholder)
  // clean: schema panel takes over, no chat
  // chat: collapsed schema header + full chat
  const showChat = systemMode === 'empty' || systemMode === 'chat'

  return (
    <div className="main-column">
      <SchemaPanel />
      {showChat && <ChatPanel />}
    </div>
  )
}