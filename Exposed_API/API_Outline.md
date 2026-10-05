# IBM webMethods Integration — Metadata APIs

**Common to all:**
- **Method:** `GET`
- **Auth Header:** `X-INSTANCE-API-KEY`
- **Base path:** `/apis/v2/rest/applications/{appId}/...`

---

## 1. Get Application by Name — `applications.json`

```
GET https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com
    /apis/v2/rest/applications/<Connector Name>
```
> Fetch connector metadata by searching application name.

---

## 2. List Actions for an Application — `actions.json`

```
GET https://prod989056.a-vir-r1.int.ipaas.automation.ibm.com
    /apis/v2/rest/applications/<application_id>/actions
```
> List all available actions for the **Hugging Face** connector.

---

## 3. Describe Action Input Schema — `action_describe_Input.json`

```
GET https://prod821590.a-yqb-c1.int.ipaas.automation.ibm.com
    /apis/v2/rest/applications/<application_id>
    /actions/<action_id>/describe/input
```
> Returns the JSON Schema for **input** fields of the `post_message_to_channel` action on **Slack**.

---

## 4. Describe Action Output Schema — `action_describe_Output.json`

```
GET https://prod821590.a-yqb-c1.int.ipaas.automation.ibm.com
    /apis/v2/rest/applications/<application_id>
    /actions/<action_id>/describe/output
```
> Returns the JSON Schema for **output** fields of the `post_message_to_channel` action on **Slack**.

---

## 5. List Triggers for an Application — `triggers.json`

```
GET https://prod821590.a-yqb-c1.int.ipaas.automation.ibm.com
    /apis/v2/rest/applications/<application_id>/triggers
```
> List all available triggers for the **Slack** connector.

---

## 6. Describe Trigger Input Schema — `triggers_describe_Input.json`

```
GET https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com
    /apis/v2/rest/applications/<application_id>
    /triggers/<trigger_id>/describe/input
```
> Returns the JSON Schema for **input/configuration** fields of the `new_message_in_a_private_channel` trigger on **Slack**.

---

## 7. Describe Trigger Output Schema — `triggers_describe_Output.json`

```
GET https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com
    /apis/v2/rest/applications/<application_id>
    /triggers/<trigger_id>/describe/output
```
> Returns the JSON Schema for **output** fields emitted by the `new_message_in_a_private_channel` trigger on **Slack**.

---

## URL Pattern Reference

| # | File | URL Pattern | Purpose |
|---|---|---|---|
| 1 | `applications.json` | `/apis/v2/rest/applications/{name}` | Get application by name |
| 2 | `actions.json` | `/apis/v2/rest/applications/{appId}/actions` | List all actions |
| 3 | `action_describe_Input.json` | `/apis/v2/rest/applications/{appId}/actions/{actionId}/describe/input` | Action input schema |
| 4 | `action_describe_Output.json` | `/apis/v2/rest/applications/{appId}/actions/{actionId}/describe/output` | Action output schema |
| 5 | `triggers.json` | `/apis/v2/rest/applications/{appId}/triggers` | List all triggers |
| 6 | `triggers_describe_Input.json` | `/apis/v2/rest/applications/{appId}/triggers/{triggerId}/describe/input` | Trigger input schema |
| 7 | `triggers_describe_Output.json` | `/apis/v2/rest/applications/{appId}/triggers/{triggerId}/describe/output` | Trigger output schema |
