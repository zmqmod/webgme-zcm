/*globals define*/
/*jshint node:true, browser:true*/

/**
 * Generated by PluginGenerator 0.14.0 from webgme on Thu Mar 24 2016 07:15:53 GMT-0700 (PDT).
 */

define([
    'plugin/PluginConfig',
    'plugin/PluginBase',
    'text!./metadata.json',
    'remote-utils/remote-utils',
    'q'
], function (
    PluginConfig,
    PluginBase,
    pluginMetadata,
    utils,
    Q) {
    'use strict';
    pluginMetadata = JSON.parse(pluginMetadata);

    /**
     * Initializes a new instance of StopExperiment.
     * @class
     * @augments {PluginBase}
     * @classdesc This class represents the plugin StopExperiment.
     * @constructor
     */
    var StopExperiment = function () {
        // Call base class' constructor.
        PluginBase.call(this);

	this.pluginMetadata = pluginMetadata;
    };

    StopExperiment.metadata = pluginMetadata;

    // Prototypal inheritance from PluginBase.
    StopExperiment.prototype = Object.create(PluginBase.prototype);
    StopExperiment.prototype.constructor = StopExperiment;

    StopExperiment.prototype.notify = function(level, msg) {
	var self = this;
	var prefix = self.projectId + '::' + self.projectName + '::' + level + '::';
	if (level=='error')
	    self.logger.error(msg);
	else if (level=='debug')
	    self.logger.debug(msg);
	else if (level=='info')
	    self.logger.info(msg);
	else if (level=='warning')
	    self.logger.warn(msg);
	self.createMessage(self.activeNode, msg, level);
	self.sendNotification(prefix+msg);
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
    StopExperiment.prototype.main = function (callback) {
        // Use self to access core, project, result, logger etc from PluginBase.
        // These are all instantiated at this point.
        var self = this;

        // Default fails
        self.result.success = false;

        if (typeof WebGMEGlobal !== 'undefined') {
            callback(new Error('Client-side execution is not supported'), self.result);
            return;
        }

        self.updateMETA({});

	// What did the user select for our configuration?
	var currentConfig = self.getCurrentConfig();
	self.returnZip = currentConfig.returnZip;

	// will be filled out by the plugin
	self.activeHosts = [];
	self.experiment = [];
	self.rosCorePort = Math.floor((Math.random() * (65535-1024) + 1024));
	self.rosCoreIp = '';

	utils.notify = function(level, msg) {self.notify(level, msg);}

	// the active node for this plugin is experiment -> experiments -> project
	var projectNode = self.core.getParent(self.core.getParent(self.activeNode));
	var projectName = self.core.getAttribute(projectNode, 'name');

	self.experimentName = self.core.getAttribute(self.activeNode, 'name');
	var path = require('path');
	self.root_dir = path.join(process.cwd(), 
				  'generated', 
				  self.project.projectId, 
				  self.branchName,
				  projectName);
	self.exp_dir = path.join(self.root_dir,
				 'experiments', 
				 self.experimentName);
	self.xml_dir = path.join(self.exp_dir,
				 'xml');

	self.notify('info', 'loading project: ' + projectName);
	return self.getActiveHosts()
	    .then(function (ah) {
		self.activeHosts = ah;
		return self.killAllActiveHosts();
	    })
	    .then(function() {
		return self.copyLogs();
	    })
	    .then(function() {
		return self.createResults();
	    })
	    .then(function() {
		return self.cleanupExperiment();
	    })
	    .then(function() {
		return self.createZip();
	    })
	    .then(function() {
		// This will save the changes. If you don't want to save;
		self.notify('info', 'saving updates to model');
		return self.save('StopExperiment updated model.');
	    })
	    .then(function (err) {
		if (err.status != 'SYNCED') {
		    callback(err, self.result);
		    return;
		}
		self.result.setSuccess(true);
		callback(null, self.result);
	    })
	    .catch(function(err) {
        	self.logger.error(err);
        	self.createMessage(self.activeNode, err, 'error');
		self.result.setSuccess(false);
		callback(err, self.result);
	    })
		.done();
    };

    StopExperiment.prototype.getActiveHosts = function() {
	var self = this;
	return self.core.loadSubTree(self.activeNode)
	    .then(function (nodes) {
		var ah = [];
		for (var i=0; i<nodes.length; i++) {
		    var node = nodes[i];
		    if (self.core.isTypeOf(node, self.META.Host)) {
			var host = self.core.getAttribute(node, 'Host'),
			artifacts = self.core.getAttribute(node, 'Artifacts'),
			user = self.core.getAttribute(node, 'User'),
			intf = self.core.getAttribute(node, 'Interface');
			ah.push({host:host, user:user, intf:intf, artifacts: artifacts});
			self.core.deleteNode(node);
		    }
		    else if (self.core.isTypeOf(node, self.META.Container)) {
			self.core.deleteNode(node);
		    }
		    else if (self.core.isTypeOf(node, self.META.FCO) && 
			     !self.core.isTypeOf(node, self.META.Experiment) &&
			     !self.core.isTypeOf(node, self.META.Documentation) &&
			     !self.core.isTypeOf(node, self.META.Results)) {
			self.core.deleteNode(node); // delete connections
		    }
		}
		return ah;
	    });
    };

    StopExperiment.prototype.killAllActiveHosts = function() {
	var self = this;
	if (self.activeHosts.length == 0)
	    throw new String('No actively deployed experiment!');
	var tasks = self.activeHosts.map(function(host) {
	    var ip = host.intf.IP;
	    var user = host.user;
	    var host_commands = [
		'pkill roscore',
		'pkill node_main',
		'rc_kill'
	    ];
	    self.notify('info', 'stopping processes on: '+ user.name + '@' + ip);
	    return utils.executeOnHost(host_commands, ip, user);
	});
	return Q.all(tasks);
    };

    StopExperiment.prototype.copyLogs = function() {
	var self = this;
	var path = require('path');
	var localDir = path.join(self.exp_dir, 'results');
	var mkdirp = require('mkdirp');

	var child_process = require('child_process');
	// clear out any previous config files
	child_process.execSync('rm -rf ' + localDir);
	// re-create it
	mkdirp.sync(localDir);

	var tasks = self.activeHosts.map(function(host) {
	    var ip = host.intf.IP;
	    var user = host.user;
	    var remoteDir = path.join(user.Directory,
				      'experiments',
				      self.experimentName);
	    self.notify('info', 'Copying experiment data from ' + ip);
	    var artTasks = host.artifacts.map(function(artifact) {
		return utils.copyFromHost(remoteDir + '/' + artifact, localDir + '/.', ip, user)
		    .catch(function(err) {
			self.notify('warning', artifact + ' not found on ' + ip);
		    });

	    });
	    return Q.all(artTasks);
	});
	return Q.all(tasks);
    };

    StopExperiment.prototype.createResults = function() {
	var self = this;
	var path = require('path');
	var fs = require('fs');
	var resultsNode = self.META['Results'];
	var localDir = path.join(self.exp_dir, 'results');
	var logs = fs.readdirSync(localDir);
	var rn = self.core.createNode({parent: self.activeNode, base: resultsNode});
	self.core.setRegistry(rn, 'position', {x: 100, y:50});
	var tasks = logs.map(function(log) {
	    var logName = log.split('/').slice(-1)[0].replace(/\./g, '_');
	    self.logger.info('setting meta attr for '+logName);
	    self.core.setAttributeMeta(rn, logName, {'type':'asset'});
	    self.logger.info('set meta attr for '+logName);
	    return self.blobClient.putFile(log, fs.readFileSync(localDir + '/' + log, 'utf8'))
		.then(function (hash) {
		    self.logger.info('got hash for '+log+': ' + hash);
		    self.core.setAttribute(rn, logName, hash);
		});
	});
	return Q.all(tasks)
	    .then(() => {
		var d = new Date();
		self.core.setAttribute(rn, 'name', 'Results-'+d.toUTCString());
	    });
    };

    StopExperiment.prototype.cleanupExperiment = function() {
	var self = this;
	var path = require('path');
	var tasks = self.activeHosts.map(function(host) {
	    var ip = host.intf.IP;
	    var user = host.user;
	    var remoteDir = path.join(user.Directory,
				      'experiments');
	    self.notify('info', 'Removing experiment data on ' + ip);
	    return utils.executeOnHost(['rm -rf ' + remoteDir], ip, user);
	});
	return Q.all(tasks);
    };
    
    StopExperiment.prototype.createZip = function() {
	var self = this;
	
	if (!self.returnZip) {
            self.notify('info','Skipping compression.');
	    return;
	}
	
	return new Promise(function(resolve, reject) {
	    var zlib = require('zlib'),
	    tar = require('tar'),
	    fstream = require('fstream'),
	    input = self.exp_dir;

	    self.notify('info', 'zipping ' + input);

	    var bufs = [];

	    var packer = tar.Pack()
		.on('error', function(e) { reject(e); });

	    var gzipper = zlib.Gzip()
		.on('error', function(e) { reject(e); })
		.on('data', function(d) { bufs.push(d); })
		.on('end', function() {
		    self.logger.debug('gzip ended.');
		    var buf = Buffer.concat(bufs);
		    var name = self.projectName + '+' + self.experimentName + '+Results';
		    self.blobClient.putFile(name+'.tar.gz',buf)
			.then(function (hash) {
			    self.result.addArtifact(hash);
			    self.notify('info', 'compression complete');
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

    return StopExperiment;
});
