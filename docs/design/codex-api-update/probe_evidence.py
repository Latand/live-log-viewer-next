"""Thread-scoped evidence checks for the local app-server probe."""
from copy import deepcopy


def record_snapshot(cases, name, response, thread_id=None):
    cases.append(deepcopy({'name': name, 'threadId': thread_id, 'response': response}))


def scenario_events(events, thread_id, begin):
    def belongs(event):
        params = event.get('params', {})
        return params.get('threadId', params.get('thread', {}).get('id')) == thread_id
    return deepcopy([event for event in events[begin:] if belongs(event)])


def injection_rows(rows, thread_id):
    return [r for r in rows if r['threadId'] == thread_id
            and r['transcript'] == thread_id + '-rollout'
            and r['record'].get('type') == 'response_item'
            and r['record'].get('payload', {}).get('id') == 'probe-context'
            and r['record']['payload'].get('role') == 'user'
            and r['record']['payload'].get('content') == [
                {'type': 'input_text', 'text': 'probe-idle-context'}]]


def dispatched(events, thread_id, client_id):
    starts = {e['params']['turn']['id'] for e in events
              if e.get('method') == 'turn/started' and e['params'].get('threadId') == thread_id}
    return any(e.get('method') == 'item/completed'
               and e['params'].get('threadId') == thread_id
               and e['params'].get('turnId') in starts
               and e['params'].get('item', {}).get('type') == 'userMessage'
               and e['params']['item'].get('clientId') == client_id
               and e['params']['item'].get('content') == [
                   {'type': 'text', 'text': client_id, 'text_elements': []}]
               for e in events)


def persisted_input(rows, thread_id, client_id, events):
    turns = {e['params']['turnId'] for e in events if e.get('method') == 'item/completed'
             and e['params'].get('threadId') == thread_id
             and e['params'].get('item', {}).get('clientId') == client_id}
    return any(r['threadId'] == thread_id and r['transcript'] == thread_id + '-rollout'
               and r['record'].get('type') == 'response_item'
               and r['record'].get('payload', {}).get('role') == 'user'
               and r['record']['payload'].get('internal_chat_message_metadata_passthrough', {}).get('turn_id') in turns
               and r['record']['payload'].get('content') == [
                   {'type': 'input_text', 'text': client_id}]
               for r in rows)


def evaluate(result):
    c = {case['name']: case['response'] for case in result['cases']}
    threads = result['threads']
    turn = c['turn_start_idle']['result']['turn']['id']
    rows = c['canonical_marker_records']
    return {
        'injection_available_without_experimental': c['inject_idle_stable_handshake'].get('result') == {},
        'idle_injection_does_not_request_model': c['idle_inject_backend_requests'] == 0,
        'queue_requires_experimental': 'experimentalApi' in c['queue_without_experimental']['error']['message'],
        'repeated_queue_key_is_not_deduplicated': len(c['queue_list_active']['result']['data']) == 3,
        'active_queue_start_refused': 'error' in c['queue_start_active'],
        'interrupt_retains_queue': len(c['queue_after_interrupt']['result']['data']) == 3,
        'restart_retains_queue': len(c['queue_cold_list']['result']['data']) == 3,
        'matching_steer_returns_current_turn': c['steer_matching'].get('result', {}).get('turnId') == turn,
        'start_while_active_returns_current_turn': c['turn_start_while_active'].get('result', {}).get('turn', {}).get('id') == turn,
        'cold_resume_dispatches_normal_queue': not c['normal_cold_resume_queue']['result']['data']
            and dispatched(c['normal_cold_resume_events'], threads['cold'], 'probe-cold-queue')
            and persisted_input(rows, threads['cold'], 'probe-cold-queue', c['normal_cold_resume_events']),
        'idle_add_dispatches_automatically': not c['idle_queue_list']['result']['data']
            and dispatched(c['idle_queue_events'], threads['idle'], 'probe-idle-queue')
            and persisted_input(rows, threads['idle'], 'probe-idle-queue', c['idle_queue_events']),
        'earlier_scenario_unchanged': c['earlier_scenario_unchanged'] is True,
        'original_thread_has_two_injections': len(injection_rows(rows, threads['injection'])) == 2,
        'second_thread_has_one_injection': len(injection_rows(rows, threads['cold'])) == 1,
        'idle_injection_reaches_next_request': c['first_backend_request']['count'] == 1
            and len(c['first_backend_request']['input']) == 2,
    }
