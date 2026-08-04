/** A response payload that is already serialized. The socket layer splices it
    into the response frame verbatim, so a multi-megabyte result is stringified
    once per journal revision instead of once per connection. */
export class PreserializedJson {
  constructor(readonly json: string) {}
}
