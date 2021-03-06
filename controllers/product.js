const formidable = require("formidable");
const _ = require("lodash");
const fs = require("fs");
const Product = require("../models/product");
const { errorHandler } = require("../helpers/dbErrorHandler");
const { getFileType, s3, uploadParams, deleteParams } = require("./amazonS3");
const { FileArray } = require("express-fileupload");
require("dotenv").config();

exports.productById = (req, res, next, id) => {
  Product.findById(id)
    .populate("category")
    .exec((err, product) => {
      if (err || !product) {
        return res.status(400).json({
          error: "Product not found",
        });
      }
      req.product = product;
      next();
    });
};

exports.read = (req, res) => {
  // req.product.photo = undefined;
  return res.json(req.product);
};

exports.create = (req, res) => {
  let form = new formidable.IncomingForm();
  // form.keepExtensions = true;
  form.parse(req, (err, fields, files) => {
    if (err) {
      return res.status(400).json({
        error: "Image could not be uploaded",
      });
    }
    // check for all fields
    const { name, description, price, category, quantity, shipping } = fields;

    if (
      !name ||
      !description ||
      !price ||
      !category ||
      !quantity ||
      !shipping
    ) {
      return res.status(400).json({
        error: "All fields are required",
      });
    }

    const product = new Product(fields);

    req.profile.hashed_password = undefined;
    req.profile.salt = undefined;
    product.soldBy = req.profile;

    const filesArray = Object.values(files);
    //console.log("filesArray", filesArray);
    const photos = new Array();

    if (!Array.isArray(filesArray) || !filesArray.length) {
      // array empty or does not exist
      return res.status(400).json({
        error: "All fields are required",
      });
    }

    for (let i = 0; i < filesArray.length; i++) {
      if (filesArray[i].size > 20000000) {
        return res.status(400).json({
          error: "Image should be less than 2mb in size, one of them is above",
        });
      }
    }

    for (let item of filesArray) {
      awsfileUpload(item);
    }

    // upload images to s3
    function awsfileUpload(file) {
      s3.upload(uploadParams("products", file, "image/*"), (error, data) => {
        if (error) {
          console.log(error);
          res.status(400).json({ error: "File upload failed" });
        }
        if (data === undefined) {
          console.log("Error: No File Selected!");
          res.json({ error: "No File Selected" });
        }
        //console.log("AWS UPLOAD RES DATA");

        product.photo.push({
          url: data.Location,
          key: data.Key,
          name: file.name,
          contentType: file.type,
        });

        //save to db
        product.save((err, result) => {
          if (err) {
            console.log("PRODUCT CREATE ERROR ", err);
            return res.status(400).json({
              error: errorHandler(err),
            });
          }
          res.json(result);
        });
      });
    }
  });
};

exports.productsByUser = (req, res) => {
  Product.find({ soldBy: req.profile._id })
    .populate("soldBy", "_id name role email")
    .select("_id name description price category quantity shipping photo")
    .sort("_createdAt")
    .exec((err, products) => {
      if (err) {
        return res.status(400).json({
          error: err,
        });
      }
      res.json(products);
    });
};

exports.isSeller = (req, res, next) => {
  let sameUser =
    req.product && req.auth && req.product.soldBy._id == req.auth._id;
  let adminUser = req.product && req.auth && req.auth.role === "admin";

  // console.log("req.post ", req.post, " req.auth ", req.auth);
  // console.log("SAMEUSER: ", sameUser, " ADMINUSER: ", adminUser);

  let isSeller = sameUser || adminUser;

  if (!isSeller) {
    return res.status(403).json({
      error: "User is not authorized",
    });
  }
  next();
};

exports.remove = (req, res) => {
  let product = req.product;
  product.remove((err, deletedProduct) => {
    if (err) {
      return res.status(400).json({
        error: errorHandler(err),
      });
    }

    // remove the existing image from s3 before uploading new/updated one
    s3.deleteObject(deleteParams(deletedProduct), function (err, data) {
      // if (err) {console.log("S3 DELETE ERROR DUING", err);
      if (err) {
        console.log("S3 DELETE ERROR DUING", err);
        return res.status(400).json({
          error: "Product Delete failed",
        });
      }
      console.log("S3 DELETED DURING", data); // deleted
      res.status(200).json({
        message: "Product deleted successfully",
      });
    });
  });
};

exports.update = (req, res) => {
  let form = new formidable.IncomingForm();
  // form.keepExtensions = true;
  form.parse(req, (err, fields, files) => {
    if (err) {
      return res.status(400).json({
        error: "Image could not be uploaded",
      });
    }

    let product = req.product;
    product = _.extend(product, fields);

    // 1kb = 1000
    // 1mb = 1000000
    let { photo } = files;

    if (photo) {
      // console.log("FILES PHOTO: ", files.photo);
      if (photo.size > 1000000) {
        return res.status(400).json({
          error: "Image should be less than 1mb in size",
        });
      }

      //delete product photo url
      s3.deleteObject(deleteParams(product), function (err, data) {
        // if (err) {console.log("S3 DELETE ERROR DUING", err);
        if (err) {
          console.log("S3 DELETE ERROR DUING", err);
          return res.status(400).json({
            error: "Product Delete failed",
          });
        }
        console.log("S3 DELETED DURING", data);
      });

      //upload the new photo to s3
      s3.upload(uploadParams("products", photo, "image/*"), (error, data) => {
        if (error) {
          console.log(error);
          res.status(400).json({ error: "File upload failed" });
        }
        if (data === undefined) {
          console.log("Error: No File Selected!");
          res.json({ error: "No File Selected" });
        }
        console.log("AWS UPLOAD RES DATA");
        product.photo.url = data.Location;
        product.photo.key = data.Key;
        product.photo.name = photo.name;
        product.photo.contentType = photo.type;

        //save to db
        product.save((err, result) => {
          if (err) {
            return res.status(400).json({
              error: errorHandler(err),
            });
          }
          res.json(result);
        });
      });
    } else {
      //save to db
      product.save((err, result) => {
        if (err) {
          return res.status(400).json({
            error: errorHandler(err),
          });
        }
        res.json(result);
      });
    }
  });
};

exports.list = (req, res) => {
  let order = req.query.order ? req.query.order : "asc";
  let sortBy = req.query.sortBy ? req.query.sortBy : "_id";
  let limit = req.query.limit ? parseInt(req.query.limit) : 6;

  Product.find()
    .populate("category")
    .sort([[sortBy, order]])
    .limit(limit)
    .exec((err, products) => {
      if (err) {
        return res.status(400).json({
          error: "Products not found",
        });
      }
      res.json(products);
    });
};

/**
 * it will find the products based on the req product category
 * other products that has the same category, will be returned
 */

exports.listRelated = (req, res) => {
  let limit = req.query.limit ? parseInt(req.query.limit) : 6;

  Product.find({ _id: { $ne: req.product }, category: req.product.category })
    .limit(limit)
    .populate("category", "_id name")
    .exec((err, products) => {
      if (err) {
        return res.status(400).json({
          error: "Products not found",
        });
      }
      res.json(products);
    });
};

exports.listCategories = (req, res) => {
  Product.distinct("category", {}, (err, categories) => {
    if (err) {
      return res.status(400).json({
        error: "Categories not found",
      });
    }
    res.json(categories);
  });
};

/**
 * list products by search
 * we will implement product search in react frontend
 * we will show categories in checkbox and price range in radio buttons
 * as the user clicks on those checkbox and radio buttons
 * we will make api request and show the products to users based on what he wants
 */

exports.listBySearch = (req, res) => {
  let order = req.body.order ? req.body.order : "desc";
  let sortBy = req.body.sortBy ? req.body.sortBy : "_id";
  let limit = req.body.limit ? parseInt(req.body.limit) : 100;
  let skip = parseInt(req.body.skip);
  let findArgs = {};

  // console.log(order, sortBy, limit, skip, req.body.filters);
  // console.log("findArgs", findArgs);

  for (let key in req.body.filters) {
    if (req.body.filters[key].length > 0) {
      if (key === "price") {
        // gte -  greater than price [0-10]
        // lte - less than
        findArgs[key] = {
          $gte: req.body.filters[key][0],
          $lte: req.body.filters[key][1],
        };
      } else {
        findArgs[key] = req.body.filters[key];
      }
    }
  }

  Product.find(findArgs)
    .populate("category")
    .sort([[sortBy, order]])
    .skip(skip)
    .limit(limit)
    .exec((err, data) => {
      if (err) {
        return res.status(400).json({
          error: "Products not found",
        });
      }
      res.json({
        size: data.length,
        data,
      });
    });
};

exports.photo = (req, res, next) => {
  if (req.product.photo.data) {
    res.set("Content-Type", req.product.photo.contentType);
    return res.send(req.product.photo.data);
  }
  next();
};

exports.listSearch = (req, res) => {
  // create query object to hold search value and category value
  const query = {};
  // assign search value to query.name
  if (req.query.search) {
    query.name = { $regex: req.query.search, $options: "i" };
    // assigne category value to query.category
    if (req.query.category && req.query.category != "All") {
      query.category = req.query.category;
    }
    // find the product based on query object with 2 properties
    // search and category
    Product.find(query, (err, products) => {
      if (err) {
        return res.status(400).json({
          error: errorHandler(err),
        });
      }
      res.json(products);
    });
  }
};

exports.decreaseQuantity = (req, res, next) => {
  let bulkOps = req.body.order.products.map((item) => {
    return {
      updateOne: {
        filter: { _id: item._id },
        update: { $inc: { quantity: -item.count, sold: +item.count } },
      },
    };
  });

  Product.bulkWrite(bulkOps, {}, (error, products) => {
    if (error) {
      return res.status(400).json({
        error: "Could not update product",
      });
    }
    next();
  });
};
