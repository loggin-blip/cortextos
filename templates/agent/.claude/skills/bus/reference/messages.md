# Messages (agent-to-agent)

## send-message
Send a message to another agent. They see it on their next inbox check. Auto-emits `message/agent_message_sent`.

```bash
cortextos bus send-message <target_agent> <priority> '<message_body>' [reply_to]
```

- **target_agent** (required): Target agent name
- **priority** (required): `urgent` | `high` | `normal` | `low`
- **message_body** (required): The message content. Use single quotes around JSON or complex strings
- **reply_to** (optional): Message ID this is responding to. Auto-ACKs the original.

Example:
```bash
cortextos bus send-message kaptein high '{"action":"deploy","repo":"website","branch":"main"}'
cortextos bus send-message kaptein normal "Ferdig med audit" msg_xyz789
```

## check-inbox
Check for incoming messages from other agents. Run EVERY heartbeat.

```bash
cortextos bus check-inbox
```

Returns a list of messages. Each has an ID you must ACK.

## ack-inbox
Acknowledge a message. Un-ACK'd messages redeliver after 5 minutes.

```bash
cortextos bus ack-inbox "<message_id>"
```

Example:
```bash
cortextos bus ack-inbox "msg_xyz789"
```

## notify-agent
Send an urgent signal to another agent's fast-checker (bypasses normal inbox polling).

```bash
cortextos bus notify-agent <agent_name> "<message>"
```

Use sparingly — this pings the receiving agent immediately.
