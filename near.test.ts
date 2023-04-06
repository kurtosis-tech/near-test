import {EnclaveContext, EnclaveUUID, KurtosisContext} from "kurtosis-sdk"
import log from "loglevel"
import {err, ok, Result} from "neverthrow"
import {PortSpec} from "kurtosis-sdk/build/core/lib/services/port_spec";
import {StarlarkRunResult} from "kurtosis-sdk/build/core/lib/enclaves/starlark_run_blocking";
import {ServiceContext} from "kurtosis-sdk/build/core/lib/services/service_context";
import fetch from "node-fetch";
import * as http from "http";

const TEST_NAME = "near-packge-test";
const MILLISECONDS_IN_SECOND = 1000;
const IS_PARTITIONING_ENABLED = false;
const SCRIPT_PARAMS = "{}"
const IS_NOT_DRY_RUN = false

const EXPLORER_FRONTEND_SERVICE_NAME = "explorer-frontend"
const EXPLORER_FRONTEND_HTTP_PORT_ID = "http"

const STARLARK_SCRIPT_CALLING_NEAR_PACKAGE = `
near_package = import_module("github.com/kurtosis-tech/near-package/main.star")
def run(plan, args):
    near_package_output = near_package.run(plan, args)
    return output
`

jest.setTimeout(180000)

/*
This example will:
1. Spin up a near package via composition
2. Make assertions on the state of the forntend
*/
test("Test NEAR package", async () => {

    // ------------------------------------- ENGINE SETUP ----------------------------------------------
    log.info("Creating the enclave")
    const createEnclaveResult = await createEnclave(TEST_NAME, IS_PARTITIONING_ENABLED)

    if (createEnclaveResult.isErr()) {
        throw createEnclaveResult.error
    }

    const {enclaveContext, destroyEnclaveFunction} = createEnclaveResult.value

    try {
        // ------------------------------------- PACKAGE RUN ----------------------------------------------
        log.info("------------ EXECUTING SCRIPT ---------------")

        const runResult: Result<StarlarkRunResult, Error> = await enclaveContext.runStarlarkScriptBlocking(STARLARK_SCRIPT_CALLING_NEAR_PACKAGE, SCRIPT_PARAMS, IS_NOT_DRY_RUN)

        if (runResult.isErr()) {
            log.error(`An error occurred execute Starlark script '${STARLARK_SCRIPT_CALLING_NEAR_PACKAGE}'`);
            throw runResult.error
        }

        expect(runResult.value.interpretationError).toBeUndefined();
        expect(runResult.value.validationErrors).toEqual([]);
        expect(runResult.value.executionError).toBeUndefined();

        log.info("------------ EXECUTING TEST ---------------")

        const getExplorerFrontendServiceCtxResult: Result<ServiceContext, Error> = await enclaveContext.getServiceContext(EXPLORER_FRONTEND_SERVICE_NAME);
        if (getExplorerFrontendServiceCtxResult.isErr()) {
            log.error("An error occurred getting the API service context");
            throw getExplorerFrontendServiceCtxResult.error;
        }
        const explorerFrontendServiceCtx: ServiceContext = getExplorerFrontendServiceCtxResult.value;
        const explorerFrontendPublicPorts: Map<string, PortSpec> = await explorerFrontendServiceCtx.getPublicPorts();
        if (explorerFrontendPublicPorts.size == 0){
            throw new Error("Expected to receive API service public ports but none was received")
        }

        if (!explorerFrontendPublicPorts.has(EXPLORER_FRONTEND_HTTP_PORT_ID)){
            throw new Error(`Expected to find explorer frontend port wih ID ${EXPLORER_FRONTEND_HTTP_PORT_ID} but it was not found`)
        }

        const explorerFrontendHttpPortSpec: PortSpec = explorerFrontendPublicPorts.get(EXPLORER_FRONTEND_HTTP_PORT_ID)!
        const explorerFrontendPublicPortNumber: number = explorerFrontendHttpPortSpec.number
        const explorerFrontendPublicAddress: string = explorerFrontendServiceCtx.getMaybePublicIPAddress()

        const apiAddress = `http://${explorerFrontendPublicAddress}:${explorerFrontendPublicPortNumber}`

        





        log.info("Test finished successfully")
    } finally {
        destroyEnclaveFunction()
    }
})

async function createEnclave(testName: string, isPartitioningEnabled: boolean):
    Promise<Result<{
        enclaveContext: EnclaveContext,
        destroyEnclaveFunction: () => Promise<Result<null, Error>>,
    }, Error>> {

    const newKurtosisContextResult = await KurtosisContext.newKurtosisContextFromLocalEngine()
    if (newKurtosisContextResult.isErr()) {
        log.error(`An error occurred connecting to the Kurtosis engine for running test ${testName}`)
        return err(newKurtosisContextResult.error)
    }
    const kurtosisContext = newKurtosisContextResult.value;

    const enclaveName: EnclaveUUID = `${testName}.${Math.round(Date.now() / MILLISECONDS_IN_SECOND)}`
    const createEnclaveResult = await kurtosisContext.createEnclave(enclaveName, isPartitioningEnabled);

    if (createEnclaveResult.isErr()) {
        log.error(`An error occurred creating enclave ${enclaveName}`)
        return err(createEnclaveResult.error)
    }

    const enclaveContext = createEnclaveResult.value;

    const destroyEnclaveFunction = async (): Promise<Result<null, Error>> => {
        const destroyEnclaveResult = await kurtosisContext.destroyEnclave(enclaveName)
        if (destroyEnclaveResult.isErr()) {
            const errMsg = `An error occurred destroying enclave ${enclaveName} that we created for this test: ${destroyEnclaveResult.error.message}`
            log.error(errMsg)
            log.error(`ACTION REQUIRED: You'll need to destroy enclave ${enclaveName} manually!!!!`)
            return err(new Error(errMsg))
        }
        return ok(null)
    }

    return ok({enclaveContext, destroyEnclaveFunction})
}

