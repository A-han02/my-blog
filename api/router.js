const express = require('express');

const authRouter = require('./auth');
const articlesRouter = require('./articles');
const searchRouter = require('./search');
const adminRouter = require('./admin');
const interactionRouter = require('./interaction');
const socialRouter = require('./social');

const router = express.Router();

router.use('/auth', authRouter);
router.use('/articles', articlesRouter);
router.use('/search', searchRouter);
router.use('/admin', adminRouter);
router.use('/interaction', interactionRouter);
router.use('/social', socialRouter);

module.exports = { apiRouter: router };
