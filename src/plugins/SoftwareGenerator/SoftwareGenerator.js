/*globals define*/
/*jshint node:true, browser:true*/

/**
 * Generated by PluginGenerator 0.14.0 from webgme on Wed Mar 02 2016 22:16:42 GMT-0600 (Central Standard Time).
 */

define([
    'plugin/PluginConfig',
    'plugin/PluginBase',
    'common/util/ejs', // for ejs templates
    'common/util/xmljsonconverter', // used to save model as json
    'plugin/SoftwareGenerator/SoftwareGenerator/Templates/Templates', // 
    'plugin/SoftwareGenerator/SoftwareGenerator/meta',
    'q'
], function (
    PluginConfig,
    PluginBase,
    ejs,
    Converter,
    TEMPLATES,
    MetaTypes,
    Q) {
    'use strict';

    /**
     * Initializes a new instance of SoftwareGenerator.
     * @class
     * @augments {PluginBase}
     * @classdesc This class represents the plugin SoftwareGenerator.
     * @constructor
     */
    var SoftwareGenerator = function () {
        // Call base class' constructor.
        PluginBase.call(this);
	//this.disableBrowserExecution = true; // why doesn't this work?
        this.metaTypes = MetaTypes;
        this.FILES = {
            'component_cpp': 'component.cpp.ejs',
            'component_hpp': 'component.hpp.ejs',
            'cmakelists': 'CMakeLists.txt.ejs',
            'package_xml': 'package_xml.ejs',
	    'doxygen_config': 'doxygen_config.ejs'
        };
    };

    // Prototypal inheritance from PluginBase.
    SoftwareGenerator.prototype = Object.create(PluginBase.prototype);
    SoftwareGenerator.prototype.constructor = SoftwareGenerator;

    /**
     * Gets the name of the SoftwareGenerator.
     * @returns {string} The name of the plugin.
     * @public
     */
    SoftwareGenerator.prototype.getName = function () {
        return 'SoftwareGenerator';
    };

    /**
     * Gets the semantic version (semver.org) of the SoftwareGenerator.
     * @returns {string} The version of the plugin.
     * @public
     */
    SoftwareGenerator.prototype.getVersion = function () {
        return '0.1.0';
    };

    /**
     * Gets the configuration structure for the ObservationSelection.
     * The ConfigurationStructure defines the configuration for the plugin
     * and will be used to populate the GUI when invoking the plugin from webGME.
     * @returns {object} The version of the plugin.
     * @public
     */
    SoftwareGenerator.prototype.getConfigStructure = function() {
        return [
            {
                'name': 'compile',
                'displayName': 'Compile Code',
                'description': 'Turn off to just generate source files.',
                'value': true,
                'valueType': 'boolean',
                'readOnly': false
            },
	    {
		'name': 'generate_docs',
		'displayName': 'Generate Doxygen Docs',
		'description': 'Turn off to ignorre doc generation.',
		'value': true,
		'valueType': 'boolean',
		'readOnly': false
	    },
	    {
		'name': 'returnZip',
		'displayName': 'Zip and return generated artifacts.',
		'description': 'If true, it enables the client to download a zip of the artifacts.',
		'value': false,
		'valueType': 'boolean',
		'readOnly': false
	    }
        ];
    };

    /**
     * Main function for the plugin to execute. This will perform the execution.
     * Notes:
     * - Always log with the provided logger.[error,warning,info,debug].
     * - Do NOT put any user interaction logic UI, etc. inside this method.
     * - callback always has to be called even if error happened.
     *
     * @param {function(string, plugin.PluginResult)} callback - the result callback
     */
    SoftwareGenerator.prototype.main = function (callback) {
        // Use self to access core, project, result, logger etc from PluginBase.
        // These are all instantiated at this point.
        var self = this;

        // Default fails
        self.result.success = false;

        if (typeof WebGMEGlobal !== 'undefined') {
            callback(new Error('Client-side execution is not supported'), self.result);
            return;
        }
	
	// What did the user select for our configuration?
	var currentConfig = self.getCurrentConfig();
        self.logger.info('Current configuration ' + JSON.stringify(currentConfig, null, 4));

        self.updateMETA(self.metaTypes);

	var path = require('path');

	// Setting up variables that will be used by various functions of this plugin
	self.gen_dir = path.join(process.cwd(), 'generated', self.project.projectId, self.branchName);
	self.compileCode = currentConfig.compile;
	self.generateDocs = currentConfig.generate_docs;
	self.returnZip = currentConfig.returnZip;
	self.projectModel = {}; // will be filled out by loadProjectModel (and associated functions)

	var projectNode = self.core.getParent(self.activeNode);

      	self.loadProjectModel(projectNode)
  	    .then(function () {
        	return self.generateArtifacts();
  	    })
	    .then(function () {
		return self.downloadLibraries();
	    })
	    .then(function () {
		return self.generateDocumentation();
	    })
	    .then(function () {
		return self.compileBinaries();
	    })
	    .then(function () {
		return self.createZip();
	    })
	    .then(function () {
        	self.result.setSuccess(true);
        	callback(null, self.result);
	    })
	    .catch(function (err) {
        	self.logger.error(err);
        	self.createMessage(self.activeNode, err.message, 'error');
        	self.result.setSuccess(false);
        	callback(err, self.result);
	    })
		.done();
    };

    SoftwareGenerator.prototype.loadProjectModel = function (projectNode) {
	var self = this;
	self.projectModel = {
	    name: self.core.getAttribute(projectNode, 'name'),
	    software: {
		packages: {},
		libraries: {}
	    },
	    systems: {},
	    deployments: {}
	};
        return self.core.loadSubTree(projectNode)
	    .then(function (nodes) {
		var messages = [],
		services = [],
		libraries = [],
		users = [],
		interfaces = [];
		for (var i=0;i<nodes.length; i+= 1) {
		    var node = nodes[i],
			nodeName = self.core.getAttribute(node, 'name'),
			parent = self.core.getParent(node),
			parentName = self.core.getAttribute(parent, 'name');
		    // RELATED TO SOFTWARE
		    if ( self.core.isTypeOf(node, self.META.Package) ) {
			self.projectModel.software.packages[nodeName] = {
			    name: nodeName,
			    messages: {},
			    services: {},
			    components: {}
			};
		    }
		    else if ( self.core.isTypeOf(node, self.META.Library) ) {
			var inclDir = self.core.getAttribute(node, 'Include Directories');
			if (inclDir == undefined)
			    inclDir = '../' + nodeName + '/include';
			self.projectModel.software.libraries[nodeName] = {
			    name: nodeName,
			    url: self.core.getAttribute(node, 'URL'),
			    linkLibs: self.core.getAttribute(node, 'Link Libraries'),
			    includeDirs: inclDir
			};
			libraries.push(node);
		    }
		    else if ( self.core.isTypeOf(node, self.META.Message) ) {
			self.projectModel.software.packages[parentName].messages[nodeName] = {
			    name: nodeName,
			    packageName: parentName,
			    definition: self.core.getAttribute(node, 'Definition')
			};
			messages.push(node);
		    }
		    else if ( self.core.isTypeOf(node, self.META.Service) ) {
			self.projectModel.software.packages[parentName].services[nodeName] = {
			    name: nodeName,
			    packageName: parentName,
			    definition: self.core.getAttribute(node, 'Definition')
			};
			services.push(node);
		    }
		    else if ( self.core.isTypeOf(node, self.META.Component) ) {
			self.projectModel.software.packages[parentName].components[nodeName] = {
			    name: nodeName,
			    packageName: parentName,
			    requiredTypes: [],
			    requiredLibs: [],
			    timers: {},
			    publishers: {},
			    subscribers: {},
			    clients: {},
			    servers: {},
			    forwards: self.core.getAttribute(node, 'Forwards'),
			    definitions: self.core.getAttribute(node, 'Definitions'),
			    initialization: self.core.getAttribute(node, 'Initialization'),
			    destruction: self.core.getAttribute(node, 'Destruction'),
			    members: self.core.getAttribute(node, 'Members')
			};
		    }
		    else if ( self.core.isTypeOf(node, self.META.Timer) ) {
			var pkgName = self.core.getAttribute(
			    self.core.getParent(parent), 'name');
			self.projectModel.software.packages[pkgName]
			    .components[parentName]
			    .timers[nodeName] = {
				name: nodeName,
				period: self.core.getAttribute(node, 'Period'),
				priority: self.core.getAttribute(node, 'Priority'),
				deadline: self.core.getAttribute(node, 'Deadline'),
				operation: self.core.getAttribute(node, 'Operation')
			    };
		    }
		    else if ( self.core.isTypeOf(node, self.META.Publisher) ) {
			var pkgName = self.core.getAttribute(
			    self.core.getParent(parent), 'name');
			self.projectModel.software.packages[pkgName]
			    .components[parentName]
			    .publishers[nodeName] = {
				name: nodeName,
				topic: {},
				priority: self.core.getAttribute(node, 'Priority'),
				networkProfile: self.core.getAttribute(node, 'NetworkProfile')
			    };
		    }
		    else if ( self.core.isTypeOf(node, self.META.Subscriber) ) {
			var pkgName = self.core.getAttribute(
			    self.core.getParent(parent), 'name');
			self.projectModel.software.packages[pkgName]
			    .components[parentName]
			    .subscribers[nodeName] = {
				name: nodeName,
				topic: {},
				priority: self.core.getAttribute(node, 'Priority'),
				networkProfile: self.core.getAttribute(node, 'NetworkProfile'),
				deadline: self.core.getAttribute(node, 'Deadline'),
				operation: self.core.getAttribute(node, 'Operation')
			    };
		    }
		    else if ( self.core.isTypeOf(node, self.META.Client) ) {
			var pkgName = self.core.getAttribute(
			    self.core.getParent(parent), 'name');
			self.projectModel.software.packages[pkgName]
			    .components[parentName]
			    .clients[nodeName] = {
				name: nodeName,
				service: {},
				priority: self.core.getAttribute(node, 'Priority'),
				networkProfile: self.core.getAttribute(node, 'NetworkProfile')
			    };
		    }
		    else if ( self.core.isTypeOf(node, self.META.Server) ) {
			var pkgName = self.core.getAttribute(
			    self.core.getParent(parent), 'name');
			self.projectModel.software.packages[pkgName]
			    .components[parentName]
			    .servers[nodeName] = {
				name: nodeName,
				service: {},
				priority: self.core.getAttribute(node, 'Priority'),
				networkProfile: self.core.getAttribute(node, 'NetworkProfile'),
				deadline: self.core.getAttribute(node, 'Deadline'),
				operation: self.core.getAttribute(node, 'Operation')
			    };
		    }
		    // RELATED TO SYSTEMS:
		    else if ( self.core.isTypeOf(node, self.META.System) ) {
			self.projectModel.systems[nodeName] = {
			    name: nodeName,
			    hosts: {},
			    networks: {},
			    users: {},
			    links: {}
			};
		    }
		    else if ( self.core.isTypeOf(node, self.META.Host) ) {
			self.projectModel.systems[parentName]
			    .hosts[nodeName] = {
				name: nodeName,
				os: self.core.getAttribute(node, 'OS'),
				architecture: self.core.getAttribute(node, 'Architecture'),
				interfaces: {},
				users: {}
			};
		    }
		    else if ( self.core.isTypeOf(node, self.META.Interface) ) {
			var systemName = self.core.getAttribute(self.core.getParent(parent), 'name');
			self.projectModel.systems[systemName]
			    .hosts[parentName]
			    .interfaces[nodeName] = {
				name: nodeName,
				ip: ''
			};
			interfaces.push(node);
		    }
		    else if ( self.core.isTypeOf(node, self.META.Network) ) {
			self.projectModel.systems[parentName]
			    .networks[nodeName] = {
				name: nodeName,
				subnet: self.core.getAttribute(node, 'Subnet'),
				netmask: self.core.getAttribute(node, 'Netmask'),
				links: []
			};
		    }
		    else if ( self.core.isTypeOf(node, self.META.User) ) {
			self.projectModel.systems[parentName]
			    .users[nodeName] = {
				name: nodeName,
				directory: self.core.getAttribute(node, 'Directory'),
				key: self.core.getAttribute(node, 'Key')
			};
			users.push(node);
		    }
		    else if ( self.core.isTypeOf(node, self.META.Link) ) {
			self.projectModel.systems[parentName]
			    .links[nodeName] = {
				name: nodeName,
				ip: self.core.getAttribute(node, 'IP')
			};
		    }
		    // RELATED TO DEPLOYMENTS:
		}
		return self.resolvePointers({
		    messages: messages,
		    services: services,
		    libraries: libraries, 
		    interfaces: interfaces,
		    users: users
		});
	    })
	    .then(function() {
		self.createMessage(self.activeNode, 'Parsed Project.');
	    });
    };

    SoftwareGenerator.prototype.resolvePointers = function (pointerDict) {
	var self = this;
	
	return self.gatherReferences(pointerDict)
	    .then(function(retData) {
		for (var i=0; i < retData.length; i++) {
		    var subarr = retData[i];
		    for (var j=0; j < subarr.length; j++) {
			var dataRef = subarr[j],
			    test = -1,
			    type = -1;
			// Relevant for software
			if (dataRef.srcType == 'Component') {
			    self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.src]
				.requiredLibs.push(
				    self.projectModel.software
					.libraries[dataRef.library]
				);
			}
			else if (dataRef.srcType == 'Publisher') {
			    type = self.projectModel
				.software.packages[dataRef.topicPackage]
				.messages[dataRef.topic];
			    self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.publishers[dataRef.src]
				.topic = type;
			    test = self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.requiredTypes
				.indexOf(type);
			}
			else if (dataRef.srcType == 'Subscriber') {
			    type = self.projectModel
				.software.packages[dataRef.topicPackage]
				.messages[dataRef.topic];
			    self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.subscribers[dataRef.src]
				.topic = type;
			    test = self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.requiredTypes
				.indexOf(type);
			}
			else if (dataRef.srcType == 'Client') {
			    type = self.projectModel
				.software.packages[dataRef.servicePackage]
				.services[dataRef.service];
			    self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.clients[dataRef.src]
				.service = type;
			    test = self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.requiredTypes
				.indexOf(type);
			}
			else if (dataRef.srcType == 'Server') {
			    type = self.projectModel
				.software.packages[dataRef.servicePackage]
				.services[dataRef.service];
			    self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.servers[dataRef.src]
				.service = type;
			    test = self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.requiredTypes
				.indexOf(type);
			}
			// Relevant for Systems
			else if (dataRef.srcType == 'Host') {
			    self.projectModel
				.systems[dataRef.systemName]
				.hosts[dataRef.src]
				.users[dataRef.user] = 
				self.projectModel
				.systems[dataRef.systemName]
				.users[dataRef.user];
			}
			else if (dataRef.srcType == 'Link') {
			    self.projectModel
				.systems[dataRef.systemName]
				.hosts[dataRef.hostName]
				.interfaces[dataRef.interfaceName].ip = dataRef.ip;
			}

			// If the pointer should not be duplicated and has not been:
			if (test == -1 && type != -1) {
			    self.projectModel.software.packages[dataRef.srcPkg]
				.components[dataRef.srcComp]
				.requiredTypes.push(type);
			}
		    }
		}
	    });
    };

    SoftwareGenerator.prototype.gatherReferences = function (pointerDict) {
	var self = this;
	var refPromises = [];
	
	var messages = pointerDict.messages,
	services = pointerDict.services,
	libraries = pointerDict.libraries,
	interfaces = pointerDict.interfaces,
	users = pointerDict.users;

	return self.core.loadCollection(messages[0], 'Message')
	    .then(function () {
		self.logger.info('iterating through messages');
		for (var i=0; i<messages.length; i++) {
		    refPromises.push(self.getMessagePointerData(messages[i]));
		}
	    }).then(function () {
		self.logger.info('iterating through services');
		for (var i=0; i<services.length; i++) {
		    refPromises.push(self.getServicePointerData(services[i]));
		}
	    }).then(function () {
		self.logger.info('iterating through libraries');
		for (var i=0; i<libraries.length; i++) {
		    refPromises.push(self.getLibraryPointerData(libraries[i]));
		}
	    }).then(function () {
		self.logger.info('iterating through interfaces');
		for (var i=0; i<interfaces.length; i++) {
		    refPromises.push(self.getInterfacePointerData(interfaces[i]));
		}
	    }).then(function () {
		self.logger.info('iterating through users');
		for (var i=0; i<users.length; i++) {
		    refPromises.push(self.getUserPointerData(users[i]));
		}
	    }).then(function () {
		return Q.all(refPromises);
	    });
    };

    SoftwareGenerator.prototype.getMessagePointerData = function (msgObj) {
	var self = this;
	var msgName = self.core.getAttribute(msgObj, 'name');
	var msgPkgName = self.core.getAttribute(self.core.getParent(msgObj), 'name');
	return self.core.loadCollection(msgObj, 'Message')
	    .then(function (nodes) {
		self.logger.info('Processing ' + nodes.length + ' nodes for message ' + msgName);
		var msgDataReferences = [];
		for (var i=0; i < nodes.length; i++) {
		    var nodeName = self.core.getAttribute(nodes[i], 'name');
		    var comp = self.core.getParent(nodes[i]);
		    var compName = self.core.getAttribute(comp, 'name');
		    var pkg = self.core.getParent(comp);
		    var pkgName = self.core.getAttribute(pkg, 'name');
		    var baseObject = self.core.getBaseType(nodes[i]);
		    var baseType = self.core.getAttribute(baseObject, 'name');
		    msgDataReferences.push({
			topic: msgName,
			topicPackage: msgPkgName,
			srcType: baseType,
			src: nodeName,
			srcComp: compName,
			srcPkg: pkgName
		    });
		}
		return msgDataReferences;
	    });
    };

    SoftwareGenerator.prototype.getServicePointerData = function (srvObj) {
	var self = this;
	var srvName = self.core.getAttribute(srvObj, 'name');
	var srvPkgName = self.core.getAttribute(self.core.getParent(srvObj), 'name');
	return self.core.loadCollection(srvObj, 'Service')
	    .then(function (nodes) {
		self.logger.info('Processing ' + nodes.length + ' nodes for service ' + srvName);
		var srvDataReferences = [];
		for (var i=0; i < nodes.length; i++) {
		    var nodeName = self.core.getAttribute(nodes[i], 'name');
		    var comp = self.core.getParent(nodes[i]);
		    var compName = self.core.getAttribute(comp, 'name');
		    var pkg = self.core.getParent(comp);
		    var pkgName = self.core.getAttribute(pkg, 'name');
		    var baseObject = self.core.getBaseType(nodes[i]);
		    var baseType = self.core.getAttribute(baseObject, 'name');
		    srvDataReferences.push({
			service: srvName,
			servicePackage: srvPkgName,
			srcType: baseType,
			src: nodeName,
			srcComp: compName,
			srcPkg: pkgName
		    });
		}
		return srvDataReferences;
	    });
    };

    SoftwareGenerator.prototype.getLibraryPointerData = function (libObj) {
	var self = this;
	var libName = self.core.getAttribute(libObj, 'name');
	var nodePathDict = self.core.isMemberOf(libObj);
	self.logger.info('Processing '+Object.keys(nodePathDict).length+' nodes for library '+libName);
	var libDataReferences = [];
	for (var nodePath in nodePathDict) {
	    libDataReferences.push(
		self.core.loadByPath(self.rootNode, nodePath)
		    .then(function (node) {
			var compName = self.core.getAttribute(node, 'name');
			var pkg = self.core.getParent(node);
			var pkgName = self.core.getAttribute(pkg, 'name');
			var baseObject = self.core.getBaseType(node);
			var baseType = self.core.getAttribute(baseObject, 'name');
			return {
			    library: libName,
			    srcType: baseType,
			    src: compName,
			    srcPkg: pkgName
			};
		    })
	    );
	}
	return Q.all(libDataReferences);
    };

    SoftwareGenerator.prototype.getInterfacePointerData = function (interfaceObj) {
	var self = this;
	var interfaceName = self.core.getAttribute(interfaceObj, 'name'),
	host = self.core.getParent(interfaceObj),
	hostName = self.core.getAttribute(host, 'name'),
	system = self.core.getParent(host),
	systemName = self.core.getAttribute(system, 'name');

	return self.core.loadCollection(interfaceObj, 'src')
	    .then(function (nodes) {
		self.logger.info('Processing ' + nodes.length + ' nodes for interface ' + interfaceName);
		var interfaceDataReferences = [];
		for (var i=0; i < nodes.length; i++) {
		    var baseObject = self.core.getBaseType(nodes[i]);
		    var baseType = self.core.getAttribute(baseObject, 'name');
		    interfaceDataReferences.push({
			ip: self.core.getAttribute(nodes[i], 'IP'),
			srcType: baseType,
			interfaceName: interfaceName,
			hostName: hostName,
			systemName: systemName
		    });
		}
		return interfaceDataReferences;
	    });
    };

    SoftwareGenerator.prototype.getUserPointerData = function (userObj) {
	var self = this;
	var userName = self.core.getAttribute(userObj, 'name');
	var nodePathDict = self.core.isMemberOf(userObj);
	self.logger.info('Processing '+Object.keys(nodePathDict).length+' nodes for user '+userName);
	var userDataReferences = [];
	for (var nodePath in nodePathDict) {
	    userDataReferences.push(
		self.core.loadByPath(self.rootNode, nodePath)
		    .then(function (node) {
			var hostName = self.core.getAttribute(node, 'name');
			var system = self.core.getParent(node);
			var systemName = self.core.getAttribute(system, 'name');
			var baseObject = self.core.getBaseType(node);
			var baseType = self.core.getAttribute(baseObject, 'name');
			return {
			    user: userName,
			    src: hostName,
			    srcType: baseType,
			    systemName: systemName
			};
		    })
	    );
	}
	return Q.all(userDataReferences);
    };

    SoftwareGenerator.prototype.generateArtifacts = function () {
	var self = this,
	    path = require('path'),
	    filendir = require('filendir'),
	    filesToAdd = {},
	    prefix = 'src/';

	filesToAdd[self.projectModel.name + '.json'] = JSON.stringify(self.projectModel, null, 2);
        filesToAdd[self.projectModel.name + '_metadata.json'] = JSON.stringify({
    	    projectID: self.project.projectId,
            commitHash: self.commitHash,
            branchName: self.branchName,
            timeStamp: (new Date()).toISOString(),
            pluginVersion: self.getVersion()
        }, null, 2);

	var projectName = self.projectModel.name,
	    doxygenConfigName = '/doxygen_config',
	    doxygenTemplate = TEMPLATES[self.FILES['doxygen_config']];
	filesToAdd[doxygenConfigName] = ejs.render(doxygenTemplate, 
						   {'projectName': projectName});

        for (var pkg in self.projectModel.software.packages) {
	    var pkgInfo = self.projectModel.software.packages[pkg],
		cmakeFileName = prefix + pkgInfo.name + '/CMakeLists.txt',
		cmakeTemplate = TEMPLATES[self.FILES['cmakelists']];
	    filesToAdd[cmakeFileName] = ejs.render(cmakeTemplate, {'pkgInfo':pkgInfo});

	    var packageXMLFileName = prefix + pkgInfo.name + '/package.xml',
		packageXMLTemplate = TEMPLATES[self.FILES['package_xml']];
	    filesToAdd[packageXMLFileName] = ejs.render(packageXMLTemplate, {'pkgInfo':pkgInfo});

	    for (var cmp in pkgInfo.components) {
		var compInfo = pkgInfo.components[cmp];
		self.generateComponentFiles(filesToAdd, prefix, pkgInfo, compInfo);
	    }

	    for (var msg in pkgInfo.messages) {
		var msgInfo = pkgInfo.messages[msg],
		    msgFileName = prefix + pkgInfo.name + '/msg/' + msgInfo.name + '.msg';
		filesToAdd[msgFileName] = msgInfo.definition;
	    }

	    for (var srv in pkgInfo.services) {
		var srvInfo = pkgInfo.services[srv],
		    srvFileName = prefix + pkgInfo.name + '/srv/' + srvInfo.name + '.srv';
		filesToAdd[srvFileName] = srvInfo.definition;
	    }
	}

	var promises = [];

	return (function () {
	    for (var f in filesToAdd) {
		var fname = path.join(self.gen_dir, f),
		data = filesToAdd[f];

		promises.push(new Promise(function(resolve, reject) {
		    filendir.writeFile(fname, data, function(err) {
			if (err) {
			    self.logger.error(err);
			    reject(err);
			}
			else {
			    resolve();
			}
		    });
		}));
	    }
	    return Q.all(promises);
	})()
	    .then(function() {
		self.logger.info('generated artifacts.');
		self.createMessage(self.activeNode, 'Generated artifacts.');
	    })
    };

    SoftwareGenerator.prototype.generateComponentFiles = function (filesToAdd, prefix, pkgInfo, compInfo) {
	var inclFileName = prefix + pkgInfo.name + '/include/' + pkgInfo.name + '/' + compInfo.name + '.hpp',
	    srcFileName = prefix + pkgInfo.name + '/src/' + pkgInfo.name + '/' + compInfo.name + '.cpp',
	    compCPPTemplate = TEMPLATES[this.FILES['component_cpp']],
	    compHPPTemplate = TEMPLATES[this.FILES['component_hpp']];
	var moment = require('moment');
	filesToAdd[inclFileName] = ejs.render(compHPPTemplate, {'compInfo':compInfo, 'moment':moment});
	filesToAdd[srcFileName] = ejs.render(compCPPTemplate, {'compInfo':compInfo, 'moment':moment});
    };

    SoftwareGenerator.prototype.downloadLibraries = function ()
    {
	var self = this;
	(function() {
	    var path = require('path'),
	    prefix = path.join(self.gen_dir, 'src');
	    var promises = [];

	    // Get the required node executable
	    var file_url = 'https://github.com/rosmod/rosmod-actor/releases/download/v0.3.1-beta/rosmod-node.zip';
	    var dir = prefix;
	    promises.push(self.wgetAndUnzipLibrary(file_url, dir));

	    // Get all the software libraries
	    for (var lib in self.projectModel.software.libraries) {
		file_url = self.projectModel.software.libraries[lib].url;
		if (file_url !== undefined)
		    promises.push(self.wgetAndUnzipLibrary(file_url, dir));
	    }
	    return Q.all(promises);
	})()
	.then(function() {
	    self.createMessage(self.activeNode, 'Downloaded libraries.');
	})
    };

    SoftwareGenerator.prototype.generateDocumentation = function () 
    {
	var self = this;
	if (!self.generateDocs) {
            self.createMessage(self.activeNode, 'Skipping documentation generation.');
	    return;
	}
	return new Promise(function(resolve, reject) {
	    var terminal = require('child_process').spawn('bash', [], {cwd:self.gen_dir});

	    terminal.stdout.on('data', function (data) {});

	    terminal.stderr.on('data', function (data) {
		/*
		var severity = 'warning';
		if (data.indexOf(severity) == -1)
		    severity = 'error';
		self.logger.error('stderr: ' + data);
		*/
	    });

	    terminal.on('exit', function (code) {
		self.logger.info('child process exited with code ' + code);
		if (code == 0)
		    resolve(code);
		else
		    reject('child process exited with code ' + code);
	    });

	    setTimeout(function() {
		self.logger.info('Sending stdin to terminal');
		terminal.stdin.write('doxygen doxygen_config\n');
		terminal.stdin.write('make -C ./doc/latex/ pdf\n');
		terminal.stdin.write('cp ./doc/latex/refman.pdf ' + self.projectModel.name  + '.pdf');
		self.logger.info('Ending terminal session');
		terminal.stdin.end();
	    }, 1000);
	})
	    .then(function() {
		self.createMessage(self.activeNode, 'Generated doxygen documentation.');
	    });
    }

    SoftwareGenerator.prototype.getValidArchitectures = function() {
	var self = this,
	validArchs = {};
	for (var sys in self.projectModel.systems) {
	    var system = self.projectModel.systems[sys];
	    for (var hst in system.hosts) {
		var host = system.hosts[hst];
		if (validArchs[host.architecture] === undefined) {
		    validArchs[host.architecture] = [];
		}
		validArchs[host.architecture].push(host);
	    }
	}
	return validArchs;
    };

    SoftwareGenerator.prototype.testConnectivity = function(host) {
	var self = this,
	ping = require('ping');
	
	var promises = [];
	// test IP connectivity
	for (var i in host.interfaces) {
	    var intf = host.interfaces[i];
	    promises.push(
		ping.promise.probe(intf.ip)
		    .then(function (res) { // {alive: bool, host: str, output: str}
			self.logger.info('Host: ' + res.host + ' isAlive? ' + res.alive);
			return res.alive;
		    })
		    .then(function(isAlive) {
			if (!isAlive)
			    return isAlive;
			// test user connection (UN + Key)
			return isAlive;
		    })
	    );
        }

	return Q.any(promises);
    };

    SoftwareGenerator.prototype.compileBinaries = function ()
    {
	/*
	  Need to cross compile these binaries: 
	  How to properly figure out which hardwares to cross compile for?
	  How to hanldle the storage of these files when cross compilation is done?
	  Do I delete them on the remote machine after I'm done?

	  - [Yes] Get the hardware model (all possible networks and machines/users)
	  - [N/A]  For each network in each system model : test subnet reachability; mark good/bad
	  - [] For each good network : test host reachability (and architecture match); mark good/bad
	  - [] For one of each good host _type_ : scp code over and issue a compile; get code back
	  
	  Hopefully can tell that cluster is same as two of the
	  devices in AGSE and so only builds for one type

	  - use 'uname -m' for just architecture (armv7l)
	  - use 'uname' for just OS (Linux)

	  var client = require('scp2');
	  client.scp('file.txt', {
  	    host: 'example.com',
	    username: 'admin',
	    password: 'password',
	    privateKey: '...',
	    path: '/home/admin/'
	  }, function(err) {})
	 */

	var self = this;

	var validArchitectures = self.getValidArchitectures();
	for (var arch in validArchitectures) {
	    for (var hst in validArchitectures[arch]) {
		var host = validArchitectures[arch][hst];
		if (self.testConnectivity(host))
		    break;
	    }
	}

	if (!self.compileCode) {
            self.createMessage(self.activeNode, 'Skipping compilation.');
	    return;
	}
	var percent = 0;
	return new Promise(function(resolve, reject) {
	    var terminal = require('child_process').spawn('bash', [], {cwd:self.gen_dir});

	    terminal.stdout.on('data', function (data) {
		var patt = new RegExp("[0-9]+%");
		var res = patt.exec(data);
		if (res !== null) {
		    var new_percent = parseInt(new String(res).replace('%',''), 10);
		    if ((new_percent-percent) > 10) {
			percent = new_percent
			self.logger.info('progress: ' + percent);
			self.sendNotification(
			    { 
				message:'compilation: ',
				progress: percent
			    }
			);
		    }
		}
	    });

	    terminal.stderr.on('data', function (data) {
		var regex = /([^:^\n]+):(\d+):(\d+):\s(\w+\s*\w*):\s(.+)\n(\s+)(.*)\s+\^+/gm;
		var match = null;
		var stdout = data.toString();
		while (match = regex.exec(stdout)) {
		    var filename = match[1].replace(self.gen_dir + '/src/', '');
		    var packageName = filename.split('/')[0];
		    var line = parseInt(match[2]);
		    var column = parseInt(match[3]);
		    var type = match[4];
		    var text = match[5];
		    var codeWhitespace = match[6];
		    var code = match[7];
		    var adjustedColumn = column - codeWhitespace.length;
		    self.logger.info('filename: ' + filename);
		    self.logger.info('packageName: ' + packageName);
		    //self.logger.error('stderr: ' + data);
		    self.createMessage(self.activeNode,
				       type + ': ' + 
				       packageName + ': ' + 
				       filename + ':' + 
				       line + ': ' + text,
				       type
				      );
		}
		//reject(data);
	    });

	    terminal.on('exit', function (code) {
		self.logger.info('child process exited with code ' + code);
		if (code == 0)
		    resolve(code);
		else
		    reject('child process exited with code ' + code);
	    });

	    setTimeout(function() {
		self.logger.info('Sending stdin to terminal');
		terminal.stdin.write('rm -rf bin\n');
		terminal.stdin.write('source /opt/ros/indigo/setup.bash\n');
		terminal.stdin.write('catkin_make -DNAMESPACE=rosmod\n');
		terminal.stdin.write('mkdir bin\n');
		terminal.stdin.write('cp devel/lib/*.so bin/.\n');
		terminal.stdin.write('cp devel/lib/node/node_main bin/.\n');
		terminal.stdin.write('rm -rf devel build\n');
		self.logger.info('Ending terminal session');
		terminal.stdin.end();
	    }, 1000);
	})
	    .then(function() {
        	self.createMessage(self.activeNode, 'Compiled binaries.');
	    });
    };

    SoftwareGenerator.prototype.createZip = function() {
	var self = this;
	
	if (!self.returnZip) {
            self.createMessage(self.activeNode, 'Skipping compression.');
	    return;
	}
	
	return new Promise(function(resolve, reject) {
	    var zlib = require('zlib'),
	    tar = require('tar'),
	    fstream = require('fstream'),
	    input = self.gen_dir;

	    self.logger.info('zipping ' + input);

	    var bufs = [];

	    var packer = tar.Pack()
		.on('error', function(e) { reject(e); });

	    var gzipper = zlib.Gzip()
		.on('error', function(e) { reject(e); })
		.on('data', function(d) { bufs.push(d); })
		.on('end', function() {
		    self.logger.info('gzip ended.');
		    var buf = Buffer.concat(bufs);
		    self.blobClient.putFile('artifacts.tar.gz',buf)
			.then(function (hash) {
			    self.result.addArtifact(hash);
			    self.logger.info('compression complete');
			    resolve();
			})
			.catch(function(err) {
			    reject(err);
			})
			    .done();
		});

	    var reader = fstream.Reader({ 'path': input, 'type': 'Directory' })
		.on('error', function(e) { reject(e); });

	    reader
		.pipe(packer)
		.pipe(gzipper);
	})
	    .then(function() {
		self.createMessage(self.activeNode, 'Created archive.');
	    });
    };

    SoftwareGenerator.prototype.getPidOnHost = function(proc, host, intf, user) {
	var self = this;

	return new Promise(function(resolve, reject) {

	    var rexec = require('remote-exec');
	    var streams = require('memory-streams');
	    
	    var stdout_writer = new streams.WritableStream();
	    stdout_writer
		.on('data', function(data) {
		    self.logger.info('stdout data: ' + data);
		})
		.on('end', function() {
		});

	    var stderr_writer = new streams.WritableStream();
	    stderr_writer
		.on('data', function(data) {
		    self.logger.error('stderr data: ' + data);
		})
		.on('end', function() {
		});

	    var connection_options = {
		port: 22,
		username: user.name,
		privateKey: require('fs').readFileSync(user.key),
		stdout: stdout_writer,
		stderr: stderr_writer
	    };
	    
	    var hosts = [
		host.interfaces[intf].ip
	    ];
	    
	    var cmds = [
		'ps aux | grep ' + proc,
	    ];
	    
	    rexec(hosts, cmds, connection_options, function(err){
		if (err) {
		    self.logger.error(err);
		    reject();
		} else {
		    self.logger.info('Great Success!!');
		    resolve();
		}
	    });
	});
    };

    SoftwareGenerator.prototype.wgetAndUnzipLibrary = function(file_url, dir) {
	var self = this;

	return new Promise(function(resolve, reject) {
	    var url = require('url'),
		path = require('path'),
		fs = require('fs'),
		unzip = require('unzip'),
		fstream = require('fstream'),
		child_process = require('child_process');
	    // extract the file name
	    var file_name = url.parse(file_url).pathname.split('/').pop();

	    self.logger.info('getting library: '+file_name +' from ' +file_url);

	    var final_dir = path.join(process.cwd(), dir).toString();
	    var final_file = path.join(final_dir, file_name);

	    // compose the wget command; -O is output file
	    var wget = 'wget --no-check-certificate -P ' + dir + ' ' + file_url;

	    // excute wget using child_process' exec function
	    var child = child_process.exec(wget, function(err, stdout, stderr) {
		if (err) {
		    reject(err);
		}
		else {
		    var fname = path.join(dir,file_name);
		    var readStream = fs.createReadStream(fname);
		    var writeStream = fstream.Writer(dir);
		    if (readStream == undefined || writeStream == undefined) {
			reject("Couldn't open " + dir + " or " + fname);
			return;
		    }
		    readStream
			.pipe(unzip.Parse())
			.pipe(writeStream);
		    fs.unlink(fname);
		    resolve('downloaded and unzipped ' + file_name + ' into ' + dir);
		}
	    });
	});
    };

    return SoftwareGenerator;
});
