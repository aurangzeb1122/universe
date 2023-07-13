const app = require("express").Router();
const Sentry = require("@sentry/node");
const axios = require("axios").default;
const d3 = import("d3");
const jsdom = require("jsdom");
var Prando = require("prando");
const { validateName } = require("../helpers/validate-community-name");
const keccak256 = require("web3-utils").keccak256;
const utf8ToHex = require("web3-utils").utf8ToHex;
const { ethers } = require("ethers");
const filter = require("../helpers/filter");
const { Service: _RegistrarService } = require("../services/RegistrarService");
const rateLimit = require("express-rate-limit");

const getCharacterSet = (name) => {
  // if name is only letters
  if (name.match(/^[a-zA-Z]+$/)) {
    return "letter";
  }
  // if name is only numbers
  if (name.match(/^[0-9]+$/)) {
    return "digit";
  }
  // if name is letters and numbers
  if (name.match(/^[a-zA-Z0-9]+$/)) {
    return "alphanumeric";
  }
  // if name is emoji
  if (name.match(/[\u{1F300}-\u{1F5FF}]/u)) {
    return "emoji";
  }

  return "mixed";
};

const background = async (tier) => {
  const response = await axios.get(
    `https://beb-public.s3.us-west-1.amazonaws.com/beb_animated${
      tier == "premium" ? "_premium" : ""
    }.svg`,
    { responseType: "text" }
  );
  const data = response.data;
  const base64Data = Buffer.from(data, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${base64Data}`;
};

const { Metadata } = require("../models/Metadata");

const { JSDOM } = jsdom;

// Rate limiting middleware
const lightLimiter = rateLimit({
  windowMs: 1_000, // 1s
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests, please try again later.",
  handler: (req, res, next) => {
    res.status(429).send("Too many requests, please try again later.");
  },
});

const heavyLimiter = rateLimit({
  windowMs: 10_000, // 10s
  max: 40, // limit each IP to 40 requests per windowMs
  message: "Too many requests, please try again later.",
  handler: (req, res, next) => {
    res.status(429).send("Too many requests, please try again later.");
  },
});

app.get("/domain/:domain", lightLimiter, async (req, res) => {
  try {
    const inputDomain = req.params.domain;
    if (
      !inputDomain ||
      inputDomain.length == 0 ||
      inputDomain.toLowerCase() != inputDomain
    ) {
      throw Error("inputDomain invalid!");
    }
    if (inputDomain.includes(".beb")) {
      if (inputDomain.split(".").length != 2) {
        throw Error("inputDomain cannot contain subdomains!");
      }
      const inputDomainSplit = inputDomain.split(".beb");
      if (inputDomainSplit[1].length > 0) {
        throw Error("inputDomain extension incorrect!");
      }
    } else if (inputDomain.includes(".")) {
      throw Error("inputDomain does not have correct extension!");
    }

    validateName(inputDomain);
    const rawDomain = inputDomain.replace(".beb", "");

    const existing = await Metadata.findOne({
      uri: keccak256(utf8ToHex(rawDomain)),
    });
    if (existing) {
      return res.json({
        created: false,
        domain: existing.domain,
        uri: existing.uri,
      });
    }

    const metadata = await Metadata.create({
      domain: rawDomain,
      uri: keccak256(utf8ToHex(rawDomain)),
    });

    return res.json({
      created: true,
      domain: metadata.domain,
      uri: metadata.uri,
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.json({
      code: "500",
      success: false,
      message: e.message,
    });
  }
});

const bebLogo =
  '<svg height="100%" fill="rgb(0,0,0,0.6)" version="1" viewBox="100 -50 1280 1280"></svg>';

app.get("/uri/:uri", heavyLimiter, async (req, res) => {
  try {
    const uri = req.params.uri;

    if (!uri || uri.length == 0) {
      throw Error("uri invalid!");
    }

    const uriBigNumber = ethers.BigNumber.from(uri);
    const max256BitValue = ethers.BigNumber.from(2).pow(256).sub(1);
    if (uriBigNumber.gt(max256BitValue)) {
      throw new Error(
        "The URI is too large to be represented in a 64-character-long hexadecimal string!"
      );
    }

    const rawHexUri = uriBigNumber.toHexString();
    const paddingZeros = 64 - (rawHexUri.length - 2); // Subtract 2 for the '0x' prefix
    const hexUri = "0x" + "0".repeat(paddingZeros) + rawHexUri.slice(2);

    const metadata = await Metadata.findOne({
      uri: hexUri,
    });
    if (!metadata) {
      const errorData = {
        name: `no_metadata_refresh_beb_domains.beb`,
        description: `This domain does not have metadata, navigate to beb.domains to refresh!`,
      };
      return res.json(errorData);
    }
    const rawDomain = metadata.domain;

    const fakeDom = new JSDOM("<!DOCTYPE html><html><body></body></html>");

    let body = (await d3).select(fakeDom.window.document).select("body");

    let rng = new Prando(rawDomain);

    const RegistrarService = new _RegistrarService();
    const owner = await RegistrarService.getOwner(rawDomain);
    const expiresAt = await RegistrarService.expiresAt(rawDomain);
    if (!owner) {
      const errorData = {
        name: `no_owner_beb_domains.beb`,
        description: `This domain does not have an owner, try refreshing metadata!`,
      };
      return res.json(errorData);
    }

    let length = [...rawDomain].length;
    let base = 0.95;
    if (!rawDomain.match(/^[\u0000-\u007f]*$/)) {
      length = 2 * length;
    }

    const textColor = "#fff";
    const colorMap = {
      free: "free",
      premium: "premium",
    };
    let color = colorMap.free;
    if (length < 10) {
      color = colorMap.premium;
    }

    const dynamicfontsize = parseInt(80 * Math.pow(base, length));
    const backgroundCard = await background(color);

    const backgroundImage = `
    <svg width="500" height="500">
      <image href="https://beb-public.s3.us-west-1.amazonaws.com/beb_gradient_background.jpg" width="100%" height="100%" preserveAspectRatio="xMidYMid slice"></image>
      <image href="${backgroundCard}" width="100%" height="100%" preserveAspectRatio="xMidYMid slice"></image>
    </svg>
  `;

    let svgContainer = body
      .append("div")
      .attr("class", "container")
      .append("svg")
      .attr("width", 500)
      .attr("height", 500)
      .attr("xmlns", "http://www.w3.org/2000/svg")
      .html(backgroundImage + bebLogo);

    svgContainer
      .append("text")
      .attr("x", 250)
      .attr("y", 475)
      .attr("font-size", `${dynamicfontsize}px`)
      .attr("font-family", "Inter, sans-serif")
      .attr("fill", textColor)
      .attr("text-anchor", "middle")
      .style("font-weight", "900")
      .style("text-shadow", "2px 2px #111111")
      .attr("text-rendering", "optimizeSpeed")
      .text(`${rawDomain}.beb`);

    const svg = body.select(".container").html();

    const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString(
      "base64"
    )}`;
    if (process.env.NODE_ENV === "development") {
      console.log(svg);
    }

    let data = {
      name: `${rawDomain}.beb`,
      owner,
      external_url: `https://${rawDomain}.beb.xyz`,
      description: `Check the status of ${rawDomain}.beb on beb.domains, and try our apps such as farquest.app and beb.xyz!`,
      host: "https://protocol.beb.xyz/graphql",
      image,
      attributes: [
        {
          trait_type: "Length",
          value: rawDomain.length,
          display_type: "number",
        },
        {
          trait_type: "Category",
          value: rawDomain.length < 10 ? "Premium Renewal" : "Free Renewal",
        },
        {
          trait_type: "Character Set",
          value: getCharacterSet(rawDomain),
        },
        {
          display_type: "date",
          trait_type: "Expiration Date",
          value: expiresAt,
        },
      ],
    };

    if (filter.isProfane(rawDomain) && process.env.MODE !== "self-hosted") {
      data = {
        name: `hidden_domain.beb`,
        description: `This domain is hidden, see beb.domains/guidelines for more details!`,
      };
    }

    return res.json(data);
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.json({
      code: "500",
      success: false,
      message: e.message,
    });
  }
});

module.exports = {
  router: app,
};
