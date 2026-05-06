/**
 * @traderalice/ibkr-client — TWS API I/O layer.
 *
 * Constructs DTO instances from @traderalice/ibkr-types as it decodes
 * incoming TWS messages.
 */

// Protocol
export { makeField, makeFieldHandleEmpty, makeMsg, readMsg, readFields } from './comm.js'
export { Connection } from './connection.js'
export { EReader } from './reader.js'
export { Decoder } from './decoder/index.js'

// Client & Wrapper
export { type EWrapper, DefaultEWrapper } from './wrapper.js'
export { EClient } from './client/index.js'
