'use strict';

import * as tl from 'azure-pipelines-task-lib/task';
import * as  path from 'path';
import * as fs from 'fs';
import * as  helmutility from 'kubernetes-common-v2/helmutility';
import * as uuidV4 from 'uuid/v4';
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';

import { getTempDirectory } from '../utils/FileHelper';
import { Helm, NameValuePair } from 'kubernetes-common-v2/helm-object-model';
import * as TaskParameters from '../models/TaskInputParameters';
import { KomposeInstaller } from '../utils/installers';
import * as utils from '../utils/utilities';

abstract class RenderEngine {
    public bake: () => Promise<any>;
    protected getTemplatePath = () => {
        return path.join(getTempDirectory(), 'baked-template-' + uuidV4() + '.yaml');
    }
}

class HelmRenderEngine extends RenderEngine {
    private helmVersion: string;

    constructor(version: string) {
        super();
        this.helmVersion = version;
    }

    public bake = async (): Promise<any> => {
        const helmPath = await helmutility.getHelm();
        const helmCommand = new Helm(helmPath, TaskParameters.namespace, this.helmVersion);
        const helmReleaseName = tl.getInput('releaseName', false);
        const result = helmCommand.template(helmReleaseName, tl.getPathInput('helmChart', true), tl.getDelimitedInput('overrideFiles', '\n'), this.getOverrideValues());
        if (result.stderr) {
            tl.setResult(tl.TaskResult.Failed, result.stderr);
            return;
        }
        const pathToBakedManifest = this.getTemplatePath();
        fs.writeFileSync(pathToBakedManifest, result.stdout);
        tl.setVariable('manifestsBundle', pathToBakedManifest);
    }

    private getOverrideValues() {
        const overridesInput = tl.getDelimitedInput('overrides', '\n');
        const overrideValues = [];
        overridesInput.forEach(arg => {
            const overrideInput = arg.split(':');
            const overrideName = overrideInput[0];
            const overrideValue = overrideInput.slice(1).join(':');
            overrideValues.push({
                name: overrideName,
                value: overrideValue
            } as NameValuePair);
        });

        return overrideValues;
    }
}

class KomposeRenderEngine extends RenderEngine {
    public bake = async (): Promise<any> => {
        if (!tl.filePathSupplied('dockerComposeFile')) {
            throw new Error(tl.loc('DockerComposeFilePathNotSupplied'));
        }

        const dockerComposeFilePath = tl.getPathInput('dockerComposeFile', true, true);
        const installer = new KomposeInstaller();
        let path = installer.checkIfExists();
        if (!path) {
            path = await installer.install();
        }
        const tool = tl.tool(path);
        const pathToBakedManifest = this.getTemplatePath();
        tool.arg(['convert', '-f', dockerComposeFilePath, '-o', pathToBakedManifest]);
        const result = tool.execSync();
        if (result.code !== 0 || result.error) {
            throw result.error;
        }
        tl.setVariable('manifestsBundle', pathToBakedManifest);
    }
}

class KustomizeRenderEngine extends RenderEngine {
    public bake = async () => {
        const kubectlPath = await utils.getKubectl();
        this.validateKustomize(kubectlPath);
        const command = tl.tool(kubectlPath);
        console.log(`[command] ${kubectlPath} kustomize ${tl.getPathInput('kustomizationPath')}`);
        command.arg(['kustomize', tl.getPathInput('kustomizationPath')]);

        const result = command.execSync({ silent: true } as IExecOptions);
        const pathToBakedManifest = this.getTemplatePath();
        fs.writeFileSync(pathToBakedManifest, result.stdout);
        tl.setVariable('manifestsBundle', pathToBakedManifest);
    };

    private validateKustomize(kubectlPath: string) {
        const command = tl.tool(kubectlPath);
        command.arg(['version', '--client=true', '-o', 'json']);
        const result = command.execSync();
        if (result.code !== 0) {
            throw result.error;
        }
        const clientVersion = JSON.parse(result.stdout).clientVersion;
        if (clientVersion && parseInt(clientVersion.major) >= 1 && parseInt(clientVersion.minor) >= 14) {
            // Do nothing
        } else {
            throw new Error(tl.loc('KubectlShouldBeUpgraded'));
        }
    }
}

export async function bake(ignoreSslErrors?: boolean) {
    const renderType = tl.getInput('renderType', true);
    let renderEngine: RenderEngine;
    switch (renderType) {
        case 'helm2':
            renderEngine = new HelmRenderEngine("2");
            break;
        case 'helm3':
            renderEngine = new HelmRenderEngine("3");
            break;
        case 'kompose':
            renderEngine = new KomposeRenderEngine();
            break;
        case 'kustomize':
            renderEngine = new KustomizeRenderEngine();
            break;
        default:
            throw Error(tl.loc('UnknownRenderType'));
    }
    await renderEngine.bake();
}
