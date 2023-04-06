import {EnclaveContext, EnclaveUUID, KurtosisContext} from "kurtosis-sdk"
import log from "loglevel"
import {err, ok, Result} from "neverthrow"
import {PortSpec} from "kurtosis-sdk/build/core/lib/services/port_spec";
import {StarlarkRunResult} from "kurtosis-sdk/build/core/lib/enclaves/starlark_run_blocking";
import {ServiceContext} from "kurtosis-sdk/build/core/lib/services/service_context";
import fetch from "node-fetch";
import * as http from "http";
import * as fs from "fs";

const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const TEST_NAME = "near-packge-test";
const MILLISECONDS_IN_SECOND = 1000;
const IS_PARTITIONING_ENABLED = false;
const SCRIPT_PARAMS = "{}"
const IS_NOT_DRY_RUN = false
const LOG_LEVEL = "info"

const EXPLORER_FRONTEND_SERVICE_NAME = "explorer-frontend"
const EXPLORER_FRONTEND_HTTP_PORT_ID = "http"

const TARGET_BLOCK_HEIGHT = 80
const TIME_TO_WAIT = 5 * 60 * 1000 // 5 minutes in milliseconds
const NEAR_COMPOSITION_SCRIPT = "./main.star"

const STARLARK_SCRIPT_CALLING_NEAR_PACKAGE = fs.readFileSync(NEAR_COMPOSITION_SCRIPT, 'utf-8')

jest.setTimeout(180000)
log.setLevel(LOG_LEVEL)

/*
This example will:
1. Spin up a near package via composition
2. Make assertions on the state of the frontend
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

        const explorerUrl = `http://${explorerFrontendPublicAddress}:${explorerFrontendPublicPortNumber}`

        log.info(`Explorer available on URL ${explorerUrl}`)

        const endTime = Date.now() + TIME_TO_WAIT;

        let blockHeight = 0

        // for a total of 5 minutes keep requesting the API until block height > TARGET_BLOCK_HEIGHT
        while (Date.now() < endTime) {
            log.info("Testing frontend by getting some data")
            const getResponse = await fetch(
                explorerUrl, {
                    method: "GET",
                }
            )

            expect(getResponse.status).toEqual(200)

            const responseBody = await getResponse.text()
            const dom = new JSDOM(responseBody)
            const document = dom.window.document
            const value = document.querySelector("#__next > div.c-AppWrapper-eIdCBM > div.c-DashboardContainer-duUWuj.container > div > div:nth-child(2) > div > div:nth-child(2) > div > div:nth-child(2) > div > div:nth-child(1) > div > div > div > div.c-CardCellText-gSWYEZ.ml-auto.align-self-center.col-md-12.col-12 > div > span").innerHTML
            blockHeight = parseInt(value.replace(",", ""))

            if (blockHeight > TARGET_BLOCK_HEIGHT) {
                break
            }
            log.info(`Current block height ${blockHeight}; target block height ${TARGET_BLOCK_HEIGHT}`)
        }


        expect(blockHeight).toBeGreaterThan(TARGET_BLOCK_HEIGHT)

        log.info("Test finished successfully")
    } finally {
        // Disabling destroy enclave for DEMO
        // destroyEnclaveFunction()
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

