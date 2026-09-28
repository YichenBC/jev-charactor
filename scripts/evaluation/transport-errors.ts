/** Fixed categories only: never persist exception messages, hosts, headers or cause objects. */
const names = ['transport_socket_closed','transport_connection_reset','transport_connection_refused','transport_timeout','transport_aborted','transport_error'] as const;
export function isTransportErrorCode(value:string):boolean{return (names as readonly string[]).includes(value);}
export function transportErrorCode(error:unknown):typeof names[number]{
  if(!(error instanceof Error))return 'transport_error';
  if(error.name==='TimeoutError')return 'transport_timeout';
  if(error.name==='AbortError')return 'transport_aborted';
  const cause=error.cause;
  const code=cause&&typeof cause==='object'&&'code' in cause?cause.code:'code' in error?error.code:undefined;
  if(code==='UND_ERR_SOCKET')return 'transport_socket_closed';
  if(code==='ECONNRESET')return 'transport_connection_reset';
  if(code==='ECONNREFUSED')return 'transport_connection_refused';
  return 'transport_error';
}
