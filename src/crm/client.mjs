import {buildCreateRequest, buildDeleteRequest, buildSearchRequest, buildUpdateRequest} from "./operations.mjs";
import {validateCreateResult, validateFederatedResult, validateOrderedMutationResult} from "./results.mjs";

const OPERATIONS = Object.freeze({search: "search", create: "create", update: "update", delete: "delete"});

function requireMethod(owner, name) {
  if (typeof owner?.[name] !== "function") throw new TypeError(`bos.${name} is required`);
}

function body(response, operation) {
  if (!response || typeof response !== "object" || !Number.isInteger(response.status)) throw new TypeError(`${operation} transport response is invalid`);
  if (response.status < 200 || response.status > 299) throw new TypeError(`${operation} transport must return a successful public response`);
  return response.body;
}

export class ProviderNeutralCrmClient {
  constructor({bos, onMutationComplete = async () => {}}) {
    for (const method of ["describe", "execute", "getDescription", "invokeStateAction"]) requireMethod(bos, method);
    if (typeof onMutationComplete !== "function") throw new TypeError("onMutationComplete must be a function");
    this.bos = bos;
    this.onMutationComplete = onMutationComplete;
  }

  async search(input) {
    const description = await this.#describe(OPERATIONS.search);
    return validateFederatedResult(body(await this.bos.execute(OPERATIONS.search, buildSearchRequest(input)), OPERATIONS.search), description);
  }

  async create(input) {
    const description = await this.#describe(OPERATIONS.create);
    const request = buildCreateRequest(input);
    const result = validateCreateResult(body(await this.bos.execute(OPERATIONS.create, request), OPERATIONS.create), description, request.source);
    await this.#afterMutation(OPERATIONS.create, result, {sources: [request.source]});
    return result;
  }

  async update(input) {
    return this.#orderedMutation(OPERATIONS.update, buildUpdateRequest(input));
  }

  async delete(input) {
    return this.#orderedMutation(OPERATIONS.delete, buildDeleteRequest(input));
  }

  async observeCreate(action, {source}) {
    const description = this.bos.getDescription(OPERATIONS.create);
    const result = validateCreateResult(body(await this.bos.invokeStateAction(action), OPERATIONS.create), description, source);
    await this.#afterMutation(OPERATIONS.create, result, {sources: [source]});
    return result;
  }

  async observeUpdate(action, {targets}) {
    return this.#observeOrderedMutation(OPERATIONS.update, action, targets);
  }

  async observeDelete(action, {targets}) {
    return this.#observeOrderedMutation(OPERATIONS.delete, action, targets);
  }

  async #describe(operation) {
    await this.bos.describe([operation]);
    return this.bos.getDescription(operation);
  }

  async #orderedMutation(operation, request) {
    const description = await this.#describe(operation);
    const result = validateOrderedMutationResult(body(await this.bos.execute(operation, request), operation), request.targets, description);
    await this.#afterMutation(operation, result, {sources: request.targets.map(({source}) => source)});
    return result;
  }

  async #observeOrderedMutation(operation, action, targets) {
    const description = this.bos.getDescription(operation);
    const result = validateOrderedMutationResult(body(await this.bos.invokeStateAction(action), operation), targets, description);
    await this.#afterMutation(operation, result, {sources: targets.map(({source}) => source)});
    return result;
  }

  async #afterMutation(operation, result, context) {
    if (result.complete !== true) return;
    const successful = operation === OPERATIONS.create
      ? ["created", "replayed"].includes(result.status)
      : result.outcomes.some(({status}) => status !== "failed" && status !== "in_progress");
    if (successful) await this.onMutationComplete({operation, result: structuredClone(result), sources: structuredClone(context.sources)});
  }
}
